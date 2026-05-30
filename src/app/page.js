'use client';
import { useState, useEffect, useRef, useMemo } from 'react';
import { createClient } from '@supabase/supabase-js';
import './globals.css';

// ─── Supabase ──────────────────────────────────────────────────────
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL  || 'https://placeholder.supabase.co';
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 'placeholder-key';
const sb       = createClient(SUPA_URL, SUPA_KEY);
const SB_READY = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

const MODEL_FAST  = 'claude-haiku-4-5';   // ~800ms first token
const MODEL_SMART = 'claude-sonnet-4-5';  // used only for study planner

// ── aiCall: non-streaming, only for JSON (syllabus parse) ─────────────────
async function aiCall(messages, system, userMeta = {}, tokens = 800) {
  try {
    const r = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_FAST, max_tokens: tokens, stream: false,
        system: system || 'You are a helpful AI assistant for students.',
        messages, ...userMeta,
      }),
    });
    if (r.status === 403) {
      const d = await r.json().catch(() => ({}));
      if (d.error?.message === 'LIMIT_REACHED') return { limitReached: true };
    }
    if (!r.ok) return { error: `Error ${r.status}` };
    const d = await r.json();
    if (d.error?.message === 'LIMIT_REACHED') return { limitReached: true };
    if (d.error) return { error: d.error.message };
    return { text: d.content?.[0]?.text || '' };
  } catch (e) { return { error: e.message }; }
}

// ── aiStream: true SSE — tokens visible instantly, 40ms batched updates ────
async function aiStream(messages, system, onChunk, onDone, userMeta = {}, smart = false, tokens = 600) {
  try {
    const r = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: smart ? MODEL_SMART : MODEL_FAST,
        max_tokens: tokens, stream: true,
        system: system || 'You are a helpful AI assistant for students.',
        messages, ...userMeta,
      }),
    });
    if (r.status === 403) {
      const d = await r.json().catch(() => ({}));
      if (d.error?.message === 'LIMIT_REACHED') { onDone('LIMIT_REACHED'); return; }
    }
    if (!r.ok) { const t = await r.text().catch(() => ''); onDone(`Error ${r.status}: ${t.slice(0, 80)}`); return; }

    const reader = r.body.getReader(), decoder = new TextDecoder();
    let full = '', buf = '', pending = '', timer = null;

    const flush = () => {
      if (!pending) return;
      full += pending; pending = ''; timer = null;
      onChunk(full);
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            pending += evt.delta.text;
            if (!timer) timer = setTimeout(flush, 40);
          }
          if (evt.type === 'error') { onDone(evt.error?.message || 'Stream error'); return; }
        } catch (_) {}
      }
    }
    if (timer) clearTimeout(timer);
    if (pending) full += pending;
    onDone(full || 'No response.');
  } catch (e) { onDone(`Connection error: ${e.message}`); }
}

// ─── Service Worker
function registerSW() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').then(reg => {
    console.log('SW registered');
  }).catch(err => console.log('SW error:', err));
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const perm = await Notification.requestPermission();
  return perm === 'granted';
}

function scheduleDeadlineNotifications(deadlines) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  deadlines.forEach(d => {
    const days = Math.ceil((new Date(d.date) - new Date()) / 86400000);
    if (days === 1) {
      setTimeout(() => {
        new Notification('📅 AGRYX Reminder', {
          body: `"${d.title}" is due tomorrow!`,
          icon: '/icon-192.png',
        });
      }, 3000);
    }
    if (days === 3) {
      setTimeout(() => {
        new Notification('⏳ AGRYX Reminder', {
          body: `"${d.title}" is due in 3 days. Start studying!`,
          icon: '/icon-192.png',
        });
      }, 5000);
    }
  });
}


const FREE_LIMIT = 1000;
const ADMIN_EMAIL = 'bikalkarna@gmail.com';

// aiCall and aiStream defined above with real streaming

// ─── Styles ────────────────────────────────────────────────────────
const S = {
  page: { fontFamily: 'system-ui,sans-serif', background: '#fafafa', minHeight: '100vh' },
  card: { background: '#fff', borderRadius: 14, border: '1px solid #ebebeb', padding: 20 },
  btnRed: { background: '#e02020', color: '#fff', border: 'none', borderRadius: 9, padding: '11px 20px', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 },
  input: { width: '100%', padding: '10px 13px', borderRadius: 8, border: '1px solid #ebebeb', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  label: { fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 1, display: 'block', marginBottom: 6 },
};

// ─── Root ──────────────────────────────────────────────────────────
export default function Root() {
  const [session, setSession] = useState(undefined);
  const [view, setView] = useState('home');

  useEffect(() => {
    registerSW();
    if (!SB_READY) { setSession(null); return; }
    sb.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) setView('app');
    });
    const { data: { subscription } } = sb.auth.onAuthStateChange((_, s) => {
      setSession(s);
      setView(s ? 'app' : 'home');
    });
    return () => subscription.unsubscribe();
  }, []);

  if (session === undefined) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16 }}>
      <Logo size={44} />
      <Spin dark />
    </div>
  );

  if (view === 'app' && session) return <App session={session} onSignOut={() => sb?.auth.signOut()} />;
  if (view === 'auth') return <AuthPage onBack={() => setView('home')} />;
  return <LandingPage onStart={() => setView('auth')} />;
}

// ─── Logo ──────────────────────────────────────────────────────────
function Logo({ size = 38 }) {
  return (
    <div style={{ width: size, height: size, background: '#e02020', borderRadius: size * 0.26, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <svg viewBox="0 0 24 24" width={size * 0.57} height={size * 0.57} fill="white"><path d="M12 2L4 7v10l8 5 8-5V7L12 2z" /></svg>
    </div>
  );
}

function LogoLockup() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Logo />
      <div>
        <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: 1 }}>AGRYX</div>
        <div style={{ fontSize: 8, color: '#e02020', letterSpacing: 3, fontWeight: 700 }}>AI STUDENT OS</div>
      </div>
    </div>
  );
}

function Spin({ dark } = {}) {
  const c = dark ? { borderColor: '#f0f0f0', borderTopColor: '#e02020' } : { borderColor: 'rgba(255,255,255,.4)', borderTopColor: '#fff' };
  return <div style={{ width: 16, height: 16, border: '2px solid', ...c, borderRadius: '50%', animation: 'spin .7s linear infinite', display: 'inline-block' }} />;
}

function Badge({ p }) {
  const c = (p || 'medium').toLowerCase();
  return <span className={`badge-${c}`}>{p}</span>;
}

function Empty({ icon, text }) {
  return <div className="empty-st"><div className="ei">{icon}</div>{text}</div>;
}

function FF({ label, children }) {
  return <div className="ff"><label>{label}</label>{children}</div>;
}

function Tabs({ tabs, active, onChange }) {
  return (
    <div className="ag-tabs">
      {tabs.map(t => (
        <button key={t.id} className={`ag-tab${active===t.id?' on':''}`} onClick={()=>onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function AIOut({ text }) {
  if (!text) return null;
  const html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/^### (.+)$/gm, '<h3 style="font-size:14px;font-weight:700;margin:14px 0 6px">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 style="font-size:15px;font-weight:800;margin:16px 0 8px">$1</h2>')
    .replace(/^- (.+)$/gm, '<li style="margin-bottom:4px">$1</li>')
    .replace(/`([^`]+)`/g, '<code style="background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:12px;font-family:monospace">$1</code>')
    .replace(/\n/g, '<br/>');
  return <div style={{ fontSize: 13, lineHeight: 1.8 }} dangerouslySetInnerHTML={{ __html: html }} />;
}

function ChatBox({ sys, welcome, suggested = [], userMeta = {}, onLimitReached }) {
  const [msgs, setMsgs] = useState(welcome ? [{ r: 'ai', t: welcome }] : []);
  const [inp, setInp] = useState('');
  const [hist, setHist] = useState([]);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState(null); // { base64, mediaType, preview }
  const [showCamera, setShowCamera] = useState(false);
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  // Stop camera stream when closed
  useEffect(() => {
    if (!showCamera && streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, [showCamera]);

  async function startCamera() {
    setShowCamera(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      setTimeout(() => { if (videoRef.current) videoRef.current.srcObject = stream; }, 100);
    } catch (e) { alert('Camera access denied. Please allow camera permissions.'); setShowCamera(false); }
  }

  function capturePhoto() {
    const canvas = document.createElement('canvas');
    canvas.width = videoRef.current.videoWidth;
    canvas.height = videoRef.current.videoHeight;
    canvas.getContext('2d').drawImage(videoRef.current, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
    const base64 = dataUrl.split(',')[1];
    setImage({ base64, mediaType: 'image/jpeg', preview: dataUrl });
    setShowCamera(false);
  }

  function handleFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please upload an image file.'); return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const dataUrl = ev.target.result;
      const base64 = dataUrl.split(',')[1];
      setImage({ base64, mediaType: file.type, preview: dataUrl });
    };
    reader.readAsDataURL(file);
  }

  function clearImage() { setImage(null); if (fileRef.current) fileRef.current.value = ''; }

  async function send(txt) {
    const t = txt || inp.trim();
    if ((!t && !image) || busy) return;
    setInp('');

    // Build message content - text + optional image
    let userContent;
    if (image) {
      userContent = [
        { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
        { type: 'text', text: t || 'Please help me with this image.' }
      ];
    } else {
      userContent = t;
    }

    const displayText = t || '📷 Image uploaded';
    const previewUrl = image?.preview;
    clearImage();

    const newHistMsg = { role: 'user', content: userContent };
    const h2 = [...hist, newHistMsg];
    setHist(h2);
    setMsgs(m => [...m, { r: 'user', t: displayText, img: previewUrl }, { r: 'ai', t: '' }]);
    setBusy(true);

    await aiStream(h2, sys,
      partial => setMsgs(m => { const u = [...m]; u[u.length - 1] = { r: 'ai', t: partial }; return u; }),
      full => {
        if (full === 'LIMIT_REACHED') { onLimitReached?.(); setMsgs(m => { const u = [...m]; u[u.length - 1] = { r: 'ai', t: '⚠️ You have used all 1000 free chats. Please upgrade to continue.' }; return u; }); }
        else setHist(h => [...h, { role: 'assistant', content: full }]);
        setBusy(false);
      },
      userMeta
    );
  }

  return (
    <div className="ag-chat-wrap">
      {/* Camera Modal */}
      {showCamera && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.9)', zIndex: 2000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16 }}>
          <video ref={videoRef} autoPlay playsInline style={{ maxWidth: '100%', maxHeight: '60vh', borderRadius: 12, background: '#000' }} />
          <div style={{ display: 'flex', gap: 12 }}>
            <button onClick={capturePhoto} style={{ padding: '14px 32px', background: '#fff', color: '#111', border: 'none', borderRadius: 50, fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>📸 Capture</button>
            <button onClick={() => setShowCamera(false)} style={{ padding: '14px 24px', background: 'rgba(255,255,255,.2)', color: '#fff', border: 'none', borderRadius: 50, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
          </div>
          <div style={{ color: 'rgba(255,255,255,.5)', fontSize: 12 }}>Point camera at your question or problem</div>
        </div>
      )}

      {/* Suggested prompts */}
      {suggested.length > 0 && msgs.length <= 1 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {suggested.map(s => <button key={s} onClick={() => send(s)} style={{ fontSize: 11, padding: '5px 12px', background: '#fff5f5', border: '1px solid #ffd0d0', borderRadius: 20, cursor: 'pointer', color: '#e02020', fontFamily: 'inherit', fontWeight: 600 }}>{s}</button>)}
        </div>
      )}

      {/* Messages */}
      <div className="ag-chat-msgs">
        {msgs.map((m, i) => (
          <div key={i} className={`ag-msg ${m.r==='user'?'ag-msg-user':'ag-msg-ai'}`}>
            {m.img && <img src={m.img} alt="uploaded" style={{ width: '100%', maxWidth: 240, borderRadius: 8, marginBottom: 8, display: 'block' }} />}
            {m.r === 'ai' && !m.t
              ? <span style={{ display: 'flex', gap: 4 }}>{[0, .2, .4].map((d, i) => <span key={i} style={{ width: 6, height: 6, background: '#aaa', borderRadius: '50%', display: 'inline-block', animation: `blink 1.2s ${d}s infinite` }} />)}</span>
              : m.r === 'ai' ? <AIOut text={m.t} /> : m.t}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {/* Image preview above input */}
      {image && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: '1px solid #ebebeb' }}>
          <img src={image.preview} alt="preview" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '2px solid #e02020' }} />
          <div style={{ flex: 1, fontSize: 12, color: '#555' }}>Image ready to send</div>
          <button onClick={clearImage} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>
      )}

      {/* Input row */}
      <div className="ag-chat-input-row">
        {/* Hidden file input */}
        <input ref={fileRef} type="file" accept="image/*" onChange={handleFileUpload} style={{ display: 'none' }} />

        {/* Camera button */}
        <button onClick={startCamera} title="Take photo" className="ag-icon-btn">📷</button>

        {/* Upload button */}
        <button onClick={() => fileRef.current?.click()} title="Upload image" className="ag-icon-btn">🖼️</button>

        {/* Text input */}
        <textarea value={inp} onChange={e => setInp(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder={image ? 'Ask about this image (or just press send)...' : 'Type a message, upload an image, or take a photo...'} rows={1} className="ag-chat-textarea" />

        {/* Send button */}
        <button onClick={() => send()} disabled={busy || (!inp.trim() && !image)} className="btn-red" style={{ alignSelf:'flex-end', padding:'11px 18px', flexShrink:0, opacity: busy||(!inp.trim()&&!image)?.6:1 }}>{busy ? <Spin /> : '→'}</button>
      </div>
      <style>{`@keyframes blink{0%,80%,100%{opacity:.2}40%{opacity:1}}`}</style>
    </div>
  );
}


// ─── Demo Chat (on landing page, no auth needed) ──────────────────
function DemoChat({ onStart }) {
  const [msgs, setMsgs] = useState([]);
  const [inp, setInp] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs]);

  const demoQs = ['Explain recursion simply','Write a cover letter intro for a tech internship','What is the difference between CPT and OPT?','Give me a 3-day study plan for a math exam'];

  async function send(txt) {
    const t = txt || inp.trim();
    if (!t || busy) return;
    setInp('');
    setMsgs(m => [...m, { r: 'user', t }, { r: 'ai', t: '' }]);
    setBusy(true);
    await aiStream(
      [{ role: 'user', content: t }],
      'You are AGRYX, a helpful AI assistant for students. Be concise and clear. Use markdown.',
      partial => setMsgs(m => { const u = [...m]; u[u.length - 1] = { r: 'ai', t: partial }; return u; }),
      () => setBusy(false)
    );
  }

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 20 }}>
        {demoQs.map(q => <button key={q} onClick={() => send(q)} style={{ fontSize: 12, padding: '8px 16px', background: '#fff5f5', border: '1px solid #ffd0d0', borderRadius: 20, cursor: 'pointer', color: '#e02020', fontFamily: 'inherit', fontWeight: 600 }}>{q}</button>)}
      </div>
      <div style={{ background: '#fafafa', borderRadius: 16, border: '1px solid #ebebeb', padding: 20, minHeight: 240, marginBottom: 16 }}>
        {msgs.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 20px', color: '#aaa' }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>🤖</div>
            <div style={{ fontWeight: 700, color: '#555', marginBottom: 8 }}>Ask AGRYX anything</div>
            <div style={{ fontSize: 13 }}>Click a question above or type below</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ maxWidth: '85%', padding: '12px 16px', borderRadius: m.r === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px', fontSize: 13, lineHeight: 1.7, alignSelf: m.r === 'user' ? 'flex-end' : 'flex-start', background: m.r === 'user' ? '#e02020' : '#fff', color: m.r === 'user' ? '#fff' : '#111', border: m.r === 'ai' ? '1px solid #ebebeb' : 'none' }}>
                {m.r === 'ai' && !m.t ? <span style={{ color: '#aaa' }}>thinking...</span> : m.r === 'ai' ? <AIOut text={m.t} /> : m.t}
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <input value={inp} onChange={e => setInp(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="Ask anything — homework, career, visa, coding..." className="ag-input" style={{ flex: 1, padding: '13px 16px', borderRadius: 12, fontSize: 14 }} />
        <button onClick={() => send()} disabled={busy || !inp.trim()} className="btn-red" style={{ padding: '12px 20px', opacity: busy || !inp.trim() ? .6 : 1 }}>{busy ? <Spin /> : 'Ask →'}</button>
      </div>
      <div style={{ textAlign: 'center', marginTop: 14, fontSize: 13 }}>
        <span style={{ color: '#aaa' }}>Get </span>
        <span style={{ color: '#e02020', fontWeight: 700, cursor: 'pointer' }} onClick={onStart}>1,000 free chats when you sign up →</span>
      </div>
    </div>
  );
}


// ─── Landing Page ──────────────────────────────────────────────────
function LandingPage({ onStart }) {
  const feats = [
    ['📄','Syllabus AI','Upload syllabus — AI extracts every deadline, exam & professor detail instantly.'],
    ['📅','Study Planner','Describe your week and AI builds a full personalised day-by-day schedule.'],
    ['💼','Career Hub','AI resume builder, LinkedIn optimiser, interview coach & job tracker.'],
    ['🌐','International Hub','F-1/J-1 visa help, CPT/OPT, IELTS essay grading, embassy prep.'],
    ['🤖','AI Assistant','Ask anything 24/7 — homework, essays, coding, math, career advice.'],
    ['✅','Tasks & Notes','Priorities, deadlines, rich notes — all synced to your account.'],
  ];
  return (
    <div className="lp-wrap">
      {/* Nav */}
      <nav className="lp-nav">
        <LogoLockup />
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={onStart} style={{ padding: '9px 20px', borderRadius: 9, border: '1.5px solid #ebebeb', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, fontFamily: 'inherit' }}>Log In</button>
          <button onClick={onStart} className="btn-red" style={{ borderRadius: 9 }}>Get Started Free →</button>
        </div>
      </nav>
      {/* Hero */}
      <div className="lp-hero">
        <div style={{ maxWidth: 760 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, background: '#fff5f5', border: '1px solid #ffd0d0', borderRadius: 40, padding: '7px 18px', fontSize: 12, fontWeight: 700, color: '#e02020', marginBottom: 28 }}>✨ AI-Powered Student OS — Free</div>
          <h1 className="lp-hero-title">Study Smarter.<br /><span style={{ color: '#e02020' }}>Achieve More.</span></h1>
          <p className="lp-hero-sub" style={{ marginBottom:40 }}>AGRYX is your all-in-one AI study companion. Upload your syllabus, plan your week, build your resume, and ace your classes with 24/7 AI help.</p>
          <div className="lp-btns">
            <button onClick={onStart} className="btn-red" style={{ padding: '14px 36px', fontSize: 15, borderRadius: 12 }}>🚀 Get Started Free</button>
            <button onClick={onStart} style={{ padding: '14px 36px', background: '#fff', color: '#111', border: '1.5px solid #ebebeb', borderRadius: 12, fontSize: 15, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>See Dashboard →</button>
          </div>
          <div style={{ display: 'flex', gap: 48, justifyContent: 'center', marginTop: 60, flexWrap: 'wrap' }}>
            {[['50K+','Students'],['98%','Satisfaction'],['10x','Productivity'],['24/7','AI Support']].map(([n,l]) => (
              <div key={l}><div style={{ fontSize: 28, fontWeight: 800 }}>{n}</div><div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>{l}</div></div>
            ))}
          </div>
        </div>
      </div>
      {/* Demo */}
      <div className="lp-section" style={{ background:'#fff' }}>
        <div style={{ textAlign:'center', marginBottom:40 }}>
          <div style={{ display:'inline-block', background:'#fff5f5', border:'1px solid #ffd0d0', borderRadius:20, padding:'6px 16px', fontSize:12, fontWeight:700, color:'#e02020', marginBottom:14 }}>LIVE DEMO — NO SIGNUP NEEDED</div>
          <h2 style={{ fontSize:36, fontWeight:800, marginBottom:12 }}>Try AGRYX AI Right Now</h2>
          <p style={{ fontSize:15, color:'#888', maxWidth:500, margin:'0 auto' }}>Ask any question and see how AGRYX helps students instantly.</p>
        </div>
        <DemoChat onStart={onStart}/>
      </div>

      {/* What is AGRYX */}
      <div className="lp-section" style={{ background:'#fafafa' }}>
        <div style={{ maxWidth:1000, margin:'0 auto', display:'grid', gap:40, alignItems:'center' }} className="lp-about-grid">
          <div>
            <div style={{ fontSize:12, fontWeight:700, color:'#e02020', letterSpacing:2, textTransform:'uppercase', marginBottom:16 }}>What is AGRYX?</div>
            <h2 style={{ fontSize:36, fontWeight:800, lineHeight:1.15, marginBottom:20 }}>Your AI-Powered Student Operating System</h2>
            <p style={{ fontSize:15, color:'#666', lineHeight:1.8, marginBottom:20 }}>AGRYX was built with one mission: <strong>help every student succeed</strong> — regardless of their background, resources, or location.</p>
            <p style={{ fontSize:15, color:'#666', lineHeight:1.8, marginBottom:20 }}>We combine powerful AI with tools designed for student life — from uploading your syllabus to building your career, from IELTS prep to visa guidance.</p>
            <p style={{ fontSize:15, color:'#666', lineHeight:1.8, marginBottom:28 }}>Whether you are a freshman or an international student navigating a new country, AGRYX is your 24/7 academic companion.</p>
            <button onClick={onStart} className="btn-red" style={{ padding:'13px 28px', fontSize:14, borderRadius:10}}>Join AGRYX Free →</button>
          </div>
          <div style={{ display:'grid' }} className="lp-feat-grid">
            {[['🎯','Mission','Help every student succeed with AI-powered tools'],['🌍','Global','Supporting students worldwide — domestic and international'],['⚡','Fast','AI replies instantly — no waiting, no delays'],['🔒','Private','Your data is yours — secure and private always']].map(([icon,title,desc])=>(
              <div key={title} style={{ background:'#fff', borderRadius:14, padding:20, border:'1px solid #ebebeb' }}><div style={{ fontSize:28, marginBottom:10 }}>{icon}</div><div style={{ fontWeight:700, fontSize:14, marginBottom:6 }}>{title}</div><div style={{ fontSize:12, color:'#888', lineHeight:1.5 }}>{desc}</div></div>
            ))}
          </div>
        </div>
      </div>

      {/* Features */}
      <div className="lp-section" style={{ background: '#fafafa' }}>
        <h2 style={{ textAlign: 'center', fontSize: 34, fontWeight: 800, marginBottom: 48 }}>Everything a Student Needs</h2>
        <div style={{ display:'grid', maxWidth:1100, margin:'0 auto' }} className="lp-feat-grid">
          {feats.map(([icon,title,desc]) => (
            <div key={title} className="card" style={{ cursor: 'default', transition: 'all .2s' }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = '#e02020'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = '#ebebeb'; e.currentTarget.style.transform = 'none'; }}>
              <div style={{ fontSize: 32, marginBottom: 14 }}>{icon}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{title}</div>
              <div style={{ fontSize: 13, color: '#888', lineHeight: 1.6 }}>{desc}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Pricing */}
      <div className="lp-section" style={{ background:'#fff' }}>
        <div style={{ textAlign:'center', marginBottom:50 }}>
          <h2 style={{ fontSize:36, fontWeight:800, marginBottom:12 }}>Simple, Student-Friendly Pricing</h2>
          <p style={{ color:'#888', fontSize:15 }}>Start free. Upgrade when you need more.</p>
        </div>
        <div style={{ display:'grid', maxWidth:900, margin:'0 auto' }} className="lp-pricing-grid">
          {[
            { name:'Free', price:'$0', period:'forever', color:'#111', bg:'#fff', features:['1,000 AI chats to start','Syllabus AI (text)','Study Planner','Tasks & Notes','Basic Career Hub'], cta:'Get Started Free', highlight:false },
            { name:'Pro', price:'$4.99', period:'/month', color:'#e02020', bg:'#fff5f5', features:['Unlimited AI chats','Everything in Free','PDF syllabus upload','Priority AI speed','Advanced resume builder','Full Career Hub'], cta:'Start Pro', highlight:true },
            { name:'Premium', price:'$14.99', period:'/month', color:'#7c3aed', bg:'#faf5ff', features:['Everything in Pro','Fastest AI responses','Personal study coach','Priority email support','Early access to features','Team/group features'], cta:'Start Premium', highlight:false },
          ].map(plan=>(
            <div key={plan.name} style={{ borderRadius:16, border:`2px solid ${plan.highlight?plan.color:'#ebebeb'}`, padding:30, background:plan.bg, position:'relative' }}>
              {plan.highlight && <div style={{ position:'absolute', top:-13, left:'50%', transform:'translateX(-50%)', background:'#e02020', color:'#fff', fontSize:11, fontWeight:700, padding:'4px 16px', borderRadius:20, whiteSpace:'nowrap' }}>MOST POPULAR</div>}
              <div style={{ fontSize:18, fontWeight:800, marginBottom:6 }}>{plan.name}</div>
              <div style={{ display:'flex', alignItems:'baseline', gap:4, marginBottom:20 }}>
                <span style={{ fontSize:36, fontWeight:800, color:plan.color }}>{plan.price}</span>
                <span style={{ fontSize:13, color:'#888' }}>{plan.period}</span>
              </div>
              {plan.features.map(f=><div key={f} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10, fontSize:13 }}><span style={{ color:plan.color, fontWeight:700 }}>✓</span>{f}</div>)}
              <button onClick={onStart} style={{ width:'100%', marginTop:16, padding:13, background:plan.highlight?plan.color:'#fff', color:plan.highlight?'#fff':plan.color, border:`2px solid ${plan.color}`, borderRadius:10, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>{plan.cta}</button>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div className="lp-section" style={{ background: '#e02020', textAlign: 'center' }}>
        <h2 style={{ fontSize: 34, fontWeight: 800, color: '#fff', marginBottom: 16 }}>Ready to Transform Your Studies?</h2>
        <p style={{ color: 'rgba(255,255,255,.8)', marginBottom: 36, fontSize: 16 }}>Join thousands of students already using AGRYX.</p>
        <button onClick={onStart} style={{ padding: '16px 44px', background: '#fff', color: '#e02020', border: 'none', borderRadius: 12, fontSize: 16, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' }}>🎓 Start For Free</button>
      </div>
      {/* PWA hint */}
      <div style={{ background: '#111', padding: '20px 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <span style={{ color: 'rgba(255,255,255,.6)', fontSize: 13 }}>📱 <strong style={{ color: '#fff' }}>Add to Home Screen</strong> — iPhone: Share → Add to Home Screen &nbsp;|&nbsp; Android: Menu → Add to Home Screen</span>
        <button onClick={onStart} className="btn-red" style={{ fontSize: 12, padding: '8px 18px' }}>Open App →</button>
      </div>
      <div style={{ background: '#0a0a0a', color: 'rgba(255,255,255,.4)', padding: '24px 48px', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, fontSize: 13 }}>
        <span>© 2025 AGRYX. Founded by Agyat Nepal.</span>
        <span>agyatnepal01@gmail.com</span>
      </div>
    </div>
  );
}

// ─── Auth ──────────────────────────────────────────────────────────
function AuthPage({ onBack }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr(''); setOk('');
    if (!email || !pw) { setErr('Please fill all fields.'); return; }
    if (mode === 'signup' && !name) { setErr('Please enter your name.'); return; }
    if (pw.length < 6) { setErr('Password must be at least 6 characters.'); return; }
    setBusy(true);
    if (mode === 'login') {
      if (!SB_READY) { setErr('App not configured. Check environment variables.'); setBusy(false); return; }
    const { error } = await sb.auth.signInWithPassword({ email, password: pw });
      if (error) setErr('Invalid email or password.');
    } else {
      if (!SB_READY) { setErr('App not configured.'); setBusy(false); return; }
    const { error } = await sb.auth.signUp({ email, password: pw, options: { data: { name } } });
      if (error) setErr(error.message);
      else setOk('Account created! Check your email or log in directly.');
    }
    setBusy(false);
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#fff,#fff5f5)', padding: 20 }}>
      <div className="card" style={{ width: '100%', maxWidth: 420 }}>
        <div style={{ marginBottom: 28 }}><LogoLockup /></div>
        <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>{mode === 'login' ? 'Welcome back 👋' : 'Create account'}</div>
        <div style={{ fontSize: 13, color: '#888', marginBottom: 24 }}>{mode === 'login' ? 'Log in to your AGRYX dashboard' : 'Start your AI-powered student journey'}</div>
        {err && <div style={{ background: '#fff0f0', border: '1px solid #ffd0d0', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#e02020', marginBottom: 14 }}>⚠️ {err}</div>}
        {ok  && <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#16a34a', marginBottom: 14 }}>✅ {ok}</div>}
        <form onSubmit={submit}>
          {mode === 'signup' && <FF label="Your Name"><input className="ag-input" type="text" placeholder="John Doe" value={name} onChange={e => setName(e.target.value)} /></FF>}
          <FF label="Email"><input className="ag-input" type="email" placeholder="you@university.edu" value={email} onChange={e => setEmail(e.target.value)} /></FF>
          <FF label="Password"><input className="ag-input" style={{ marginBottom: 4 }} type="password" placeholder="••••••••" value={pw} onChange={e => setPw(e.target.value)} /></FF>
          <button type="submit" disabled={busy} className="btn-red btn-full" style={{ padding:14, marginTop:8, opacity:busy?.7:1 }}>
            {busy ? <Spin /> : mode === 'login' ? '🚀 Log In' : '🎓 Create Account'}
          </button>
        </form>
        <div style={{ textAlign: 'center', marginTop: 18, fontSize: 13, color: '#888' }}>
          {mode === 'login'
            ? <>No account? <span style={{ color: '#e02020', fontWeight: 700, cursor: 'pointer' }} onClick={() => { setMode('signup'); setErr(''); }}>Sign up free</span></>
            : <>Have account? <span style={{ color: '#e02020', fontWeight: 700, cursor: 'pointer' }} onClick={() => { setMode('login'); setErr(''); }}>Log in</span></>}
        </div>
        <div style={{ textAlign: 'center', marginTop: 12 }}>
          <span style={{ fontSize: 12, color: '#aaa', cursor: 'pointer' }} onClick={onBack}>← Back to homepage</span>
        </div>
      </div>
    </div>
  );
}

// ─── Upgrade Modal ─────────────────────────────────────────────────
function UpgradeModal({ onClose, uid, userEmail }) {
  const [loading, setLoading] = useState('');

  async function checkout(plan) {
    setLoading(plan);
    const siteUrl = window.location.origin;
    try {
      const r = await fetch('/api/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan, userId: uid, userEmail, siteUrl }),
      });
      const d = await r.json();
      if (d.url) { window.location.href = d.url; }
      else { alert('Payment setup coming soon! Contact: agyatnepal01@gmail.com'); setLoading(''); }
    } catch (e) { alert('Error: ' + e.message); setLoading(''); }
  }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:20, padding:36, width:'100%', maxWidth:620, maxHeight:'90vh', overflowY:'auto' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
          <div><div style={{ fontSize:22, fontWeight:800 }}>Upgrade AGRYX</div><div style={{ fontSize:13, color:'#888', marginTop:4 }}>You have used all 1,000 free chats. Upgrade to continue.</div></div>
          <button onClick={onClose} style={{ background:'none', border:'none', fontSize:24, cursor:'pointer', color:'#888' }}>×</button>
        </div>
        <div style={{ display:'grid', marginBottom:20 }} className="lp-feat-grid">
          {[
            { id:'pro', name:'AGRYX Pro', price:'$4.99/mo', color:'#e02020', bg:'#fff5f5', features:['Unlimited AI chats','Priority responses','PDF syllabus upload','Advanced resume builder'] },
            { id:'premium', name:'AGRYX Premium', price:'$14.99/mo', color:'#7c3aed', bg:'#faf5ff', features:['Everything in Pro','Fastest AI responses','Personal study coach','Priority support'] },
          ].map(p=>(
            <div key={p.id} style={{ border:`2px solid ${p.color}`, borderRadius:16, padding:24, background:p.bg }}>
              <div style={{ fontSize:18, fontWeight:800, marginBottom:4 }}>{p.name}</div>
              <div style={{ fontSize:28, fontWeight:800, color:p.color, marginBottom:16 }}>{p.price}</div>
              {p.features.map(f=><div key={f} style={{ display:'flex', gap:8, marginBottom:8, fontSize:13 }}><span style={{ color:p.color }}>✓</span>{f}</div>)}
              <button onClick={()=>checkout(p.id)} disabled={!!loading} style={{ width:'100%', marginTop:16, padding:12, background:p.color, color:'#fff', border:'none', borderRadius:10, fontSize:14, fontWeight:700, cursor:'pointer', fontFamily:'inherit', opacity:loading===p.id?.7:1 }}>
                {loading===p.id?<Spin/>:`Start ${p.name}`}
              </button>
            </div>
          ))}
        </div>
        <div style={{ textAlign:'center', fontSize:12, color:'#aaa' }}>Secure payment via Stripe · Cancel anytime · Contact: agyatnepal01@gmail.com</div>
      </div>
    </div>
  );
}


// ─── App Shell ─────────────────────────────────────────────────────
function App({ session, onSignOut }) {
  const [page, setPage] = useState('dashboard');
  const [open, setOpen] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [notifPrompt, setNotifPrompt] = useState(false);
  const [profile, setProfile] = useState({ name: session.user.user_metadata?.name || 'Student', major: 'Computer Science', university: '', year: 'Freshman', status: 'Domestic Student', careerGoal: '', courses: [], plan: 'free', chatCount: 0 });
  const [deadlines, setDeadlines] = useState([]);
  const [tasks, setTasks]     = useState([]);
  const [notes, setNotes]     = useState([]);
  const uid      = session.user.id;
  const isAdmin  = session.user.email === ADMIN_EMAIL;
  const isPaid   = isAdmin || profile.plan === 'pro' || profile.plan === 'premium';

  // Built once — stable reference passed to all AI calls
  const userMeta = useMemo(() => ({ userId: uid, userEmail: session.user.email }), [uid]);

  useEffect(() => { if (sb) load(); }, []);

  async function load() {
    if (!SB_READY) return;
    // All 4 queries fire simultaneously — not sequentially
    const [p, d, t, n] = await Promise.all([
      sb.from('profiles').select('name,major,university,year,status,career_goal,courses,plan,chat_count').eq('id', uid).single(),
      sb.from('deadlines').select('id,title,type,date,priority,points').eq('user_id', uid).order('date').limit(50),
      sb.from('tasks').select('id,title,priority,due,done').eq('user_id', uid).limit(100),
      sb.from('notes').select('id,title,content,created_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(50),
    ]);
    if (p.data) setProfile(prev => ({ ...prev, name: p.data.name || prev.name, major: p.data.major || prev.major, university: p.data.university || '', year: p.data.year || 'Freshman', status: p.data.status || 'Domestic Student', careerGoal: p.data.career_goal || '', courses: p.data.courses || [], plan: p.data.plan || 'free', chatCount: p.data.chat_count || 0 }));
    if (d.data) {
      setDeadlines(d.data);
      if ('Notification' in window && Notification.permission === 'granted') {
        scheduleDeadlineNotifications(d.data);
      }
    }
    if (t.data) setTasks(t.data);
    if (n.data) setNotes(n.data);
    if ('Notification' in window && Notification.permission === 'default') {
      setTimeout(() => setNotifPrompt(true), 5000);
    }
  }

  async function saveProfile(p) {
    setProfile(p);
    await sb.from('profiles').upsert({ id: uid, name: p.name, major: p.major, university: p.university, year: p.year, status: p.status, career_goal: p.careerGoal, courses: p.courses });
  }

  async function addDeadline(d)   { const item = { ...d, id: `d${Date.now()}`, user_id: uid }; setDeadlines(prev => [...prev, item].sort((a,b) => new Date(a.date)-new Date(b.date))); await sb.from('deadlines').insert(item); }
  // Batch insert — used by syllabus AI to avoid sequential loop
  async function addDeadlines(items) {
    const rows = items.map(d => ({ ...d, user_id: uid }));
    setDeadlines(prev => [...prev, ...rows].sort((a,b) => new Date(a.date)-new Date(b.date)));
    await sb.from('deadlines').upsert(rows);
  }
  async function delDeadline(id)  { setDeadlines(prev => prev.filter(d => d.id !== id)); await sb.from('deadlines').delete().eq('id', id); }
  async function addTask(t)       { const item = { ...t, id: `t${Date.now()}`, user_id: uid, done: false }; setTasks(prev => [...prev, item]); await sb.from('tasks').insert(item); }
  async function toggleTask(id)   { const task = tasks.find(t => t.id === id); setTasks(prev => prev.map(t => t.id === id ? { ...t, done: !t.done } : t)); await sb.from('tasks').update({ done: !task?.done }).eq('id', id); }
  async function delTask(id)      { setTasks(prev => prev.filter(t => t.id !== id)); await sb.from('tasks').delete().eq('id', id); }
  async function addNote(n)       { const item = { ...n, id: `n${Date.now()}`, user_id: uid, created_at: new Date().toISOString() }; setNotes(prev => [item, ...prev]); await sb.from('notes').insert(item); }
  async function delNote(id)      { setNotes(prev => prev.filter(n => n.id !== id)); await sb.from('notes').delete().eq('id', id); }

  const initials = profile.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const navItems = [
    ['dashboard','🏠','Dashboard'],['syllabus','📄','Syllabus AI'],['planner','📅','Study Planner'],
    ['tasks','✅','Tasks & Notes'],['career','💼','Career Hub'],['international','🌐','International Hub'],
    ['resources','📚','Resources'],['assistant','🤖','AI Assistant'],['settings','⚙️','Settings'],
  ];
  // userMeta and onLimitReached passed to ALL page components — previously missing
  const props = { profile, deadlines, tasks, notes, addDeadline, addDeadlines, delDeadline, addTask, toggleTask, delTask, addNote, delNote, saveProfile, setPage, uid, userMeta, onLimitReached: () => setShowUpgrade(true) };

  function nav(p) { setPage(p); setOpen(false); }

  return (
    <div style={{ fontFamily:'inherit', background:'#fafafa', minHeight:'100vh' }}>

      {/* Overlay */}
      <div className={`ag-overlay${open?' show':''}`} onClick={()=>setOpen(false)}/>

      {/* Sidebar */}
      <div className={`ag-sidebar${open?' open':''}`}>
        <div style={{ padding: '18px 16px', borderBottom: '1px solid #ebebeb', cursor: 'pointer' }} onClick={() => nav('dashboard')}><LogoLockup /></div>
        <nav style={{ flex: 1, padding: '12px 10px', overflowY: 'auto' }}>
          {navItems.map(([id, icon, label]) => (
            <button key={id} className={`ag-nav-btn${page === id ? ' on' : ''}`} onClick={() => nav(id)}
              >
              <span style={{ fontSize: 17, width: 22, textAlign: 'center' }}>{icon}</span>{label}
            </button>
          ))}
        </nav>
        <div style={{ padding: '12px 14px', borderTop: '1px solid #ebebeb' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#e02020', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, flexShrink: 0 }}>{initials}</div>
            <div><div style={{ fontSize: 12, fontWeight: 700 }}>{profile.name}</div><div style={{ fontSize: 10, color: '#888' }}>{profile.major}</div></div>
          </div>
          <button onClick={onSignOut} style={{ width: '100%', padding: 8, background: 'none', border: '1px solid #ebebeb', borderRadius: 7, fontSize: 12, cursor: 'pointer', color: '#888', fontFamily: 'inherit' }}>🚪 Sign Out</button>
        </div>
      </div>

      {open && <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 199 }} />}

      {/* Topbar */}
      <div className="ag-topbar">
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <button className="ag-hamburger" onClick={()=>setOpen(o=>!o)} aria-label="Menu">☰</button>
          <div className="ag-searchbar" style={{ display:'flex', alignItems:'center', gap:8, background:'#fafafa', border:'1px solid #ebebeb', borderRadius:9, padding:'7px 14px', width:240 }}>
            <span style={{ color:'#aaa', fontSize:14 }}>🔍</span>
            <input style={{ border:'none', outline:'none', background:'transparent', fontSize:13, width:'100%', fontFamily:'inherit' }} placeholder="Search..." readOnly/>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <NotifBell deadlines={deadlines}/>
          {!isPaid && <button className="ag-upgrade-btn btn-red" onClick={()=>setShowUpgrade(true)} style={{ fontSize:11, padding:'7px 14px' }}>⬆ Upgrade</button>}
          <div style={{ display:'flex', alignItems:'center', gap:8, background:'#fafafa', border:'1px solid #ebebeb', borderRadius:9, padding:'6px 12px', fontSize:13, fontWeight:600 }}>
            <div style={{ width:26, height:26, borderRadius:'50%', background:'#e02020', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700 }}>{initials}</div>
            <span style={{ maxWidth:100, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{profile.name}</span>
          </div>
        </div>
      </div>
      {/* Main */}
      <div className="ag-main" key={page}>
        {page === 'dashboard'     && <PgDash {...props} />}
        {page === 'syllabus'      && <PgSyllabus {...props} />}
        {page === 'planner'       && <PgPlanner {...props} />}
        {page === 'tasks'         && <PgTasks {...props} />}
        {page === 'career'        && <PgCareer {...props} />}
        {page === 'international' && <PgIntl {...props} />}
        {page === 'resources'     && <PgResources {...props} />}
        {page === 'assistant'     && <PgAssistant {...props} />}
        {page === 'settings'      && <PgSettings {...props} onSignOut={onSignOut} />}
      </div>

      {/* Mobile Bottom Nav */}
      <nav className="ag-bottomnav">
        {[['dashboard','🏠','Home'],['assistant','🤖','AI'],['syllabus','📄','Syllabus'],['tasks','✅','Tasks'],['settings','⚙️','Settings']].map(([id,icon,label])=>(
          <button key={id} className={`ag-bn-item${page===id?' on':''}`} onClick={()=>nav(id)}>
            <span className="ag-bn-icon">{icon}</span>
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {/* Notification permission prompt - shows after login */}
      {notifPrompt && (
        <div style={{ position:'fixed', bottom:90, left:16, right:16, background:'#111', color:'#fff', borderRadius:14, padding:'16px 18px', zIndex:500, display:'flex', alignItems:'center', gap:12, boxShadow:'0 8px 32px rgba(0,0,0,.3)' }}>
          <span style={{ fontSize:28 }}>🔔</span>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, fontSize:14 }}>Enable Notifications</div>
            <div style={{ fontSize:12, color:'rgba(255,255,255,.7)', marginTop:2 }}>Get deadline reminders so you never miss an exam</div>
          </div>
          <div style={{ display:'flex', gap:8, flexShrink:0 }}>
            <button onClick={()=>setNotifPrompt(false)} style={{ padding:'7px 12px', background:'rgba(255,255,255,.15)', color:'#fff', border:'none', borderRadius:7, fontSize:12, cursor:'pointer', fontFamily:'inherit' }}>Later</button>
            <button onClick={async()=>{ const ok=await requestNotificationPermission(); setNotifPrompt(false); if(ok) scheduleDeadlineNotifications(deadlines); }} style={{ padding:'7px 12px', background:'#e02020', color:'#fff', border:'none', borderRadius:7, fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit' }}>Allow</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NotifBell({ deadlines }) {
  const [open, setOpen] = useState(false);
  const soon = deadlines.filter(d => { const days = Math.ceil((new Date(d.date) - new Date()) / 86400000); return days >= 0 && days <= 7; });
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', position: 'relative', lineHeight: 1 }}>
        🔔{soon.length > 0 && <span style={{ position: 'absolute', top: -2, right: -2, width: 8, height: 8, background: '#e02020', borderRadius: '50%', border: '2px solid #fff', display: 'block' }} />}
      </button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 36, background: '#fff', border: '1px solid #ebebeb', borderRadius: 12, padding: 16, width: 280, zIndex: 300, boxShadow: '0 8px 24px rgba(0,0,0,.1)' }}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 12 }}>🔔 This Week</div>
          {soon.length === 0 ? <div style={{ fontSize: 12, color: '#888' }}>No deadlines this week.</div> :
            soon.map(d => { const days = Math.ceil((new Date(d.date) - new Date()) / 86400000); return (
              <div key={d.id} style={{ padding: '8px 0', borderBottom: '1px solid #f5f5f5', fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{d.title}</div>
                <div style={{ color: days <= 2 ? '#e02020' : '#888' }}>{days === 0 ? 'Due today!' : days === 1 ? 'Tomorrow' : `${days} days left`}</div>
              </div>
            );})}
        </div>
      )}
    </div>
  );
}

// ─── Dashboard ─────────────────────────────────────────────────────
function PgDash({ profile, deadlines, tasks, notes, setPage }) {
  const [inp, setInp] = useState('');
  const sorted = [...deadlines].sort((a,b) => new Date(a.date)-new Date(b.date));
  const nextExam = sorted.find(d => ['Exam','Midterm','Final'].includes(d.type));
  const daysLeft = nextExam ? Math.max(0, Math.ceil((new Date(nextExam.date)-new Date())/86400000)) : null;
  const active = tasks.filter(t => !t.done).slice(0,3);
  const h = new Date().getHours();
  const greet = h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening';

  function qplan() { if (!inp.trim()) return; sessionStorage.setItem('qp', inp); setPage('planner'); }

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800 }}>Good {greet}, {profile.name} 👋</h1>
        <p style={{ color: '#888', fontSize: 13, marginTop: 4 }}>Let AGRYX organise your studies, workload and goals with AI.</p>
      </div>

      {/* Planner box */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <div style={{ width: 38, height: 38, background: '#e02020', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 18 }}>✨</div>
          <div><div style={{ fontWeight: 700, fontSize: 15 }}>AI Life Planner</div><div style={{ fontSize: 12, color: '#888' }}>Describe your week and AI creates a perfect study schedule.</div></div>
        </div>
        <div style={{ display: 'flex', gap: 10, marginBottom: 14 }}>
          <input className="ag-input" style={{ flex: 1 }} value={inp} onChange={e => setInp(e.target.value)} onKeyDown={e => e.key === 'Enter' && qplan()} placeholder='"I have biology exam Friday and work 20 hrs this week..."' />
          <button className="btn-red" onClick={qplan}>✨ Generate Plan</button>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {['📋 Study Plan','🚩 Priorities','⏱ Focus Blocks','🌙 Sleep Advice','⏳ Exam Prep'].map(p => (
            <button key={p} onClick={() => { sessionStorage.setItem('qp', p.slice(2)); setPage('planner'); }} style={{ fontSize: 11, color: '#888', cursor: 'pointer', background: 'none', border: 'none', fontFamily: 'inherit' }}>{p}</button>
          ))}
        </div>
      </div>

      {/* 3-col */}
      <div style={{ display:'grid', gap:16, marginBottom:16 }} className="rg-dash">
        <div className="card">
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center' }}>📅 Upcoming Deadlines <button onClick={() => setPage('syllabus')} style={{ marginLeft: 'auto', fontSize: 11, color: '#e02020', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' }}>+ Add</button></div>
          {sorted.length === 0 ? <Empty icon="📄" text="Upload your syllabus to auto-populate!" /> :
            sorted.slice(0,5).map(d => { const days = Math.ceil((new Date(d.date)-new Date())/86400000); return (
              <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid #f5f5f5' }}>
                <div><div style={{ fontSize: 13, fontWeight: 600 }}>{d.title}</div><div style={{ fontSize: 11, color: '#888' }}>{d.type}</div></div>
                <div style={{ textAlign: 'right' }}><div style={{ fontSize: 11, color: days<=3?'#e02020':'#888', fontWeight: days<=3?700:400, marginBottom: 2 }}>{days===0?'Today!':days===1?'Tomorrow':`${days}d`}</div><Badge p={d.priority} /></div>
              </div>
            );})}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>⏳ Exam Countdown</div>
            {nextExam ? (<>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{nextExam.title}</div>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>{nextExam.date}</div>
              <div style={{ fontSize: 40, fontWeight: 800 }}>{daysLeft}</div>
              <div style={{ fontSize: 13, color: '#888' }}>Days Left</div>
              <button className="btn-red" style={{ marginTop: 12, fontSize: 12, padding: '8px 14px' }} onClick={() => { sessionStorage.setItem('qp', `Study plan for ${nextExam.title} in ${daysLeft} days`); setPage('planner'); }}>📅 Make Plan</button>
            </>) : <div style={{ fontSize: 12, color: '#888' }}>No exams. <span style={{ color: '#e02020', cursor: 'pointer' }} onClick={() => setPage('syllabus')}>Upload syllabus →</span></div>}
          </div>
          <div className="card">
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center' }}>✅ Tasks <button onClick={() => setPage('tasks')} style={{ marginLeft: 'auto', fontSize: 11, color: '#e02020', fontWeight: 600, background: 'none', border: 'none', cursor: 'pointer' }}>View all</button></div>
            {active.length === 0 ? <div style={{ fontSize: 12, color: '#888' }}>No tasks. <span style={{ color: '#e02020', cursor: 'pointer' }} onClick={() => setPage('tasks')}>Add →</span></div> :
              active.map(t => <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid #f5f5f5' }}><div style={{ width: 16, height: 16, borderRadius: '50%', border: '2px solid #ebebeb', flexShrink: 0 }} /><div style={{ flex: 1, fontSize: 12 }}>{t.title}</div><Badge p={t.priority} /></div>)}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card">
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>❤️ AI Insights</div>
            {[['🔴', deadlines.length > 0 ? `${deadlines.length} deadlines tracked. Stay on top!` : 'Upload syllabus for smart reminders.'],['⭐','Great initiative using AGRYX today.'],['🌙','Aim for 7–8 hours sleep tonight.'],['🟢','You\'re building great study habits!']].map(([icon,msg],i) => (
              <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 10 }}><span>{icon}</span><span style={{ fontSize: 12, color: '#555', lineHeight: 1.5 }}>{msg}</span></div>
            ))}
          </div>
          <div className="card">
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>📝 Recent Notes</div>
            {notes.length === 0 ? <div style={{ fontSize: 12, color: '#888' }}>No notes. <span style={{ color: '#e02020', cursor: 'pointer' }} onClick={() => setPage('tasks')}>Add →</span></div> :
              notes.slice(0,3).map(n => <div key={n.id} style={{ padding: '7px 0', borderBottom: '1px solid #f5f5f5' }}><div style={{ fontSize: 12, fontWeight: 600 }}>{n.title}</div><div style={{ fontSize: 11, color: '#888' }}>{(n.content||'').slice(0,50)}...</div></div>)}
          </div>
        </div>
      </div>

      {/* 4-col quick links */}
      <div style={{ display:'grid', gap:14 }} className="rg-4">
        {[['📋','Syllabus AI','Upload → AI auto-extracts all deadlines.','⬆ Upload','syllabus'],['🌐','International Hub','Visa, CPT/OPT, IELTS, embassy prep.','Open Hub →','international'],['💼','Career Hub','AI resume, LinkedIn, interview coach.','Open Hub →','career'],['🤖','AI Assistant','Ask anything 24/7.','Chat Now 💬','assistant']].map(([icon,title,desc,cta,pg]) => (
          <div key={title} className="card" style={{ cursor: 'pointer' }} onClick={() => setPage(pg)}>
            <div style={{ fontSize: 24, marginBottom: 10 }}>{icon}</div>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{title}</div>
            <div style={{ fontSize: 12, color: '#888', lineHeight: 1.5, marginBottom: 12 }}>{desc}</div>
            <div style={{ fontSize: 12, color: '#e02020', fontWeight: 700 }}>{cta}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Syllabus ──────────────────────────────────────────────────────
function PgSyllabus({ deadlines, addDeadline, addDeadlines, delDeadline, userMeta = {}, onLimitReached }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [course, setCourse] = useState(null);
  const [prof, setProf] = useState(null);
  const [msg, setMsg] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [nd, setNd] = useState({ title:'', type:'Assignment', date:'', priority:'Medium', points:'' });
  const ref = useRef();

  async function process() {
    if (!text.trim()) { alert('Paste or upload syllabus text first.'); return; }
    setBusy(true); setMsg('');
    const res = await aiCall(
      [{ role:'user', content:`Parse this syllabus. Return ONLY valid JSON:\n{"course":{"name":"","code":"","credits":"","semester":""},"professor":{"name":"","email":"","office":"","officeHours":""},"assignments":[{"title":"","type":"Assignment|Quiz|Exam|Midterm|Final|Project","date":"YYYY-MM-DD","priority":"High|Medium|Low","points":""}]}\n\nSyllabus:\n${text.slice(0,4000)}` }],
      'Return only valid JSON. No markdown. No explanation.',
      userMeta, 800
    );
    setBusy(false);
    if (res.limitReached) { onLimitReached?.(); return; }
    if (res.error) { setMsg('⚠️ Error: ' + res.error); return; }
    try {
      const data = JSON.parse((res.text||'').replace(/```json\n?/g,'').replace(/```/g,'').trim());
      setCourse(data.course); setProf(data.professor);
      // Batch upsert — not a sequential for-loop
      const items = (data.assignments||[]).map((a,i) => ({ id:`s${Date.now()}${i}`, title:a.title||'Assignment', type:a.type||'Assignment', date:a.date||'TBD', priority:a.priority||'Medium', points:a.points||'' }));
      await addDeadlines(items);
      setMsg(`✅ ${items.length} assignments extracted and added to your dashboard!`);
    } catch { setMsg('⚠️ Could not parse. Try pasting cleaner syllabus text.'); }
  }

  async function addManual() {
    if (!nd.title || !nd.date) { alert('Title and date required.'); return; }
    await addDeadline({ ...nd });
    setNd({ title:'', type:'Assignment', date:'', priority:'Medium', points:'' }); setShowAdd(false);
  }

  return (
    <div>
      <div style={{ marginBottom: 22 }}><h1 style={{ fontSize: 24, fontWeight: 800 }}>📄 Smart Syllabus AI</h1><p style={{ color: '#888', fontSize: 13 }}>Upload your syllabus — AI extracts all assignments, deadlines & professor info automatically.</p></div>
      <div style={{ display:'grid', gap:16, marginBottom:16 }} className="rg-2">
        <div>
          <div onClick={() => ref.current?.click()} style={{ border: '2px dashed #ebebeb', borderRadius: 14, padding: 40, textAlign: 'center', cursor: 'pointer', marginBottom: 14, transition: 'border-color .2s' }} onMouseEnter={e => e.currentTarget.style.borderColor='#e02020'} onMouseLeave={e => e.currentTarget.style.borderColor='#ebebeb'}>
            <input ref={ref} type="file" accept=".txt,.doc,.docx" onChange={e => { const f=e.target.files[0]; if(f) new Response(f).text().then(t=>setText(t)); }} style={{ display: 'none' }} />
            <div style={{ fontSize: 36, marginBottom: 10 }}>📤</div>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Click to upload</div>
            <div style={{ fontSize: 12, color: '#888' }}>TXT, DOC. For PDF: copy-paste below.</div>
          </div>
          <FF label="Or paste syllabus text"><textarea className="ag-input" style={{ resize: 'vertical', minHeight: 200 }} value={text} onChange={e => setText(e.target.value)} placeholder="Paste your full syllabus here..." /></FF>
          <button className="btn-red btn-full" onClick={process} disabled={busy}>{busy ? <><Spin /> Extracting...</> : '✨ Extract with AI & Add to Dashboard'}</button>
          {msg && <div style={{ marginTop: 12, background: msg.startsWith('✅')?'#f0fdf4':'#fffbeb', border:`1px solid ${msg.startsWith('✅')?'#bbf7d0':'#fde68a'}`, borderRadius: 10, padding: '12px 16px', fontSize: 13, color: msg.startsWith('✅')?'#166534':'#92400e' }}>{msg}</div>}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card"><div style={{ fontSize:14,fontWeight:700,marginBottom:12 }}>🎓 Course Info</div>{course?<div style={{fontSize:13}}><div style={{fontWeight:700,fontSize:15}}>{course.name}</div><div style={{color:'#888',fontSize:12,marginTop:4}}>{course.code} · {course.credits} · {course.semester}</div></div>:<Empty icon="📚" text="Appears after upload"/>}</div>
          <div className="card"><div style={{ fontSize:14,fontWeight:700,marginBottom:12 }}>👨‍🏫 Professor</div>{prof?<div style={{fontSize:13}}><div style={{fontWeight:700}}>{prof.name}</div>{prof.email&&<div style={{color:'#888',fontSize:12,marginTop:4}}>📧 {prof.email}</div>}{prof.office&&<div style={{color:'#888',fontSize:12}}>🏢 {prof.office}</div>}{prof.officeHours&&<div style={{color:'#888',fontSize:12}}>⏰ {prof.officeHours}</div>}</div>:<div style={{fontSize:12,color:'#888'}}>Auto-extracts here</div>}</div>
          <div className="card">
            <div style={{ fontSize:14,fontWeight:700,marginBottom:12,display:'flex',alignItems:'center' }}>➕ Add Manually <button onClick={() => setShowAdd(s=>!s)} style={{ marginLeft:'auto',fontSize:11,color:'#e02020',fontWeight:600,background:'none',border:'none',cursor:'pointer' }}>{showAdd?'Cancel':'+ Add'}</button></div>
            {showAdd&&<div>
              <FF label="Title"><input className="ag-input" value={nd.title} onChange={e=>setNd(d=>({...d,title:e.target.value}))} placeholder="Assignment title"/></FF>
              <div style={{display:'grid', gap:10}} className="stats-grid">
                <FF label="Type"><select className="ag-input" value={nd.type} onChange={e=>setNd(d=>({...d,type:e.target.value}))}><option>Assignment</option><option>Exam</option><option>Midterm</option><option>Final</option><option>Quiz</option><option>Project</option></select></FF>
                <FF label="Priority"><select className="ag-input" value={nd.priority} onChange={e=>setNd(d=>({...d,priority:e.target.value}))}><option>High</option><option>Medium</option><option>Low</option></select></FF>
              </div>
              <FF label="Date"><input className="ag-input" type="date" value={nd.date} onChange={e=>setNd(d=>({...d,date:e.target.value}))}/></FF>
              <button className="btn-red btn-full" onClick={addManual}>Add Deadline</button>
            </div>}
          </div>
        </div>
      </div>
      <div className="card">
        <div style={{ fontSize:14,fontWeight:700,marginBottom:12 }}>📋 All Deadlines ({deadlines.length})</div>
        {deadlines.length===0?<Empty icon="📋" text="Upload a syllabus to auto-extract deadlines"/>:
          deadlines.map(d=><div key={d.id} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'10px 0',borderBottom:'1px solid #f5f5f5'}}>
            <div><div style={{fontSize:13,fontWeight:600}}>{d.title}</div><div style={{fontSize:11,color:'#888'}}>{d.type}{d.points&&` · ${d.points} pts`}</div></div>
            <div style={{display:'flex',gap:10,alignItems:'center'}}><span style={{fontSize:11,color:'#888'}}>{d.date}</span><Badge p={d.priority}/><button onClick={()=>delDeadline(d.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#ccc',fontSize:16}}>×</button></div>
          </div>)}
      </div>
    </div>
  );
}

// ─── Planner ───────────────────────────────────────────────────────
function PgPlanner({ profile, deadlines, userMeta={}, onLimitReached }) {
  const [desc, setDesc] = useState('');
  const [out, setOut]   = useState('');
  const [busy, setBusy] = useState(false);
  const sorted = [...deadlines].sort((a,b)=>new Date(a.date)-new Date(b.date));

  useEffect(()=>{const q=sessionStorage.getItem('qp');if(q){setDesc(q);sessionStorage.removeItem('qp');setTimeout(()=>gen(q),400);}}, []);

  async function gen(custom) {
    const d = custom||desc; if(!d.trim()) return;
    setBusy(true); setOut('');
    const dlCtx = deadlines.length ? `Deadlines: ${deadlines.slice(0,6).map(x=>`${x.title} (${x.date})`).join(', ')}` : '';
    await aiStream(
      [{role:'user',content:`Study plan for ${profile.major} student. ${dlCtx}\nSituation: ${d}\nCreate 7-day schedule: table (Day|Time|Task|Duration), goals, tips.`}],
      'You are a study coach. Create practical study plans with tables.',
      p=>setOut(p), ()=>setBusy(false),
      userMeta, true, 1000  // Sonnet + more tokens for scheduling
    );
  }

  const quick=['Plan my week with all deadlines','Finals week survival plan','I procrastinate — help me focus','Balance work and study this week'];
  return (
    <div>
      <div style={{marginBottom:22}}><h1 style={{fontSize:24,fontWeight:800}}>📅 AI Study Planner</h1><p style={{color:'#888',fontSize:13}}>Describe your situation and AI creates your complete study schedule.</p></div>
      <div style={{display:'grid', gap:16}} className="rg-2">
        <div>
          <div className="card" style={{marginBottom:16}}>
            <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>🤖 Your Situation</div>
            <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>{quick.map(q=><button key={q} onClick={()=>setDesc(q)} style={{fontSize:11,padding:'5px 12px',background:'#fff5f5',border:'1px solid #ffd0d0',borderRadius:20,cursor:'pointer',color:'#e02020',fontFamily:'inherit',fontWeight:600}}>{q}</button>)}</div>
            <textarea className="ag-input" style={{resize:'vertical',marginBottom:12,minHeight:120}} value={desc} onChange={e=>setDesc(e.target.value)} placeholder='"I have biology midterm June 6, chemistry quiz May 27, work 20hrs/week, wake 7am..."'/>
            <button className="btn-red btn-full" onClick={()=>gen()} disabled={busy}>{busy?<><Spin/>Generating...</>:'✨ Generate My Study Plan'}</button>
          </div>
          <div className="card">
            <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📅 Deadlines</div>
            {sorted.length===0?<div style={{fontSize:12,color:'#888'}}>No deadlines yet.</div>:sorted.map(d=>{const days=Math.ceil((new Date(d.date)-new Date())/86400000);return <div key={d.id} style={{display:'flex',justifyContent:'space-between',padding:'8px 0',borderBottom:'1px solid #f5f5f5',fontSize:12}}><div><div style={{fontWeight:600}}>{d.title}</div><div style={{color:'#888',fontSize:11}}>{d.type}</div></div><div style={{display:'flex',gap:8,alignItems:'center'}}><span style={{color:days<=3?'#e02020':'#888',fontWeight:days<=3?700:400}}>{days===0?'Today!':days===1?'Tomorrow':`${days}d`}</span><Badge p={d.priority}/></div></div>;})}
          </div>
        </div>
        <div className="card" style={{minHeight:400}}>
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📋 Your AI Plan</div>
          {busy&&!out&&<div style={{display:'flex',alignItems:'center',gap:12,color:'#888',fontSize:13}}><Spin dark/>Crafting your plan...</div>}
          {out?<AIOut text={out}/>:!busy&&<Empty icon="🗓️" text="Your personalised plan appears here"/>}
        </div>
      </div>
    </div>
  );
}

// ─── Tasks & Notes ─────────────────────────────────────────────────
function PgTasks({ tasks, notes, addTask, toggleTask, delTask, addNote, delNote }) {
  const [tab, setTab] = useState('tasks');
  const [title,setTitle]=useState(''); const [pri,setPri]=useState('Medium'); const [due,setDue]=useState('');
  const [nt,setNt]=useState(''); const [nc,setNc]=useState('');
  const [filter,setFilter]=useState('all'); const [exp,setExp]=useState(null);
  const filtered = filter==='all'?tasks:filter==='active'?tasks.filter(t=>!t.done):tasks.filter(t=>t.done);

  return (
    <div>
      <div style={{marginBottom:22}}><h1 style={{fontSize:24,fontWeight:800}}>✅ Tasks & Notes</h1><p style={{color:'#888',fontSize:13}}>Organise your to-dos and notes — synced to your account.</p></div>
      <Tabs tabs={[{id:'tasks',label:'✅ Tasks'},{id:'notes',label:'📝 Notes'}]} active={tab} onChange={setTab}/>
      {tab==='tasks'&&<div style={{display:'grid', gap:16}} className="rg-2">
        <div className="card">
          <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>➕ Add Task</div>
          <FF label="Title"><input className="ag-input" value={title} onChange={e=>setTitle(e.target.value)} onKeyDown={e=>e.key==='Enter'&&title&&(addTask({title,priority:pri,due}),setTitle(''),setDue(''))} placeholder="What needs to be done?"/></FF>
          <div style={{display:'grid', gap:10}} className="stats-grid">
            <FF label="Priority"><select className="ag-input" value={pri} onChange={e=>setPri(e.target.value)}><option>High</option><option>Medium</option><option>Low</option></select></FF>
            <FF label="Due"><input className="ag-input" type="date" value={due} onChange={e=>setDue(e.target.value)}/></FF>
          </div>
          <button className="btn-red btn-full" onClick={()=>{if(!title)return;addTask({title,priority:pri,due});setTitle('');setDue('');}}>+ Add Task</button>
          <div style={{marginTop:20,borderTop:'1px solid #ebebeb',paddingTop:16}}>
            <div style={{display:'flex',gap:6,marginBottom:14,alignItems:'center'}}>
              {['all','active','done'].map(f=><button key={f} onClick={()=>setFilter(f)} style={{padding:'5px 12px',borderRadius:20,fontSize:12,cursor:'pointer',background:filter===f?'#e02020':'#fafafa',color:filter===f?'#fff':'#888',border:'none',fontFamily:'inherit',fontWeight:600,textTransform:'capitalize'}}>{f}</button>)}
              <span style={{marginLeft:'auto',fontSize:12,color:'#888'}}>{tasks.filter(t=>!t.done).length} active</span>
            </div>
            {filtered.length===0?<div style={{fontSize:12,color:'#888',textAlign:'center',padding:20}}>No tasks here.</div>:
              filtered.map(t=>{const days=t.due?Math.ceil((new Date(t.due)-new Date())/86400000):null;return(
                <div key={t.id} style={{display:'flex',alignItems:'center',gap:10,padding:'9px 0',borderBottom:'1px solid #f5f5f5',opacity:t.done?.6:1}}>
                  <button onClick={()=>toggleTask(t.id)} style={{width:18,height:18,borderRadius:'50%',border:`2px solid ${t.done?'#16a34a':'#ebebeb'}`,cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',background:t.done?'#16a34a':'none',flexShrink:0,fontSize:11,color:'#fff',fontFamily:'inherit'}}>{t.done&&'✓'}</button>
                  <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,textDecoration:t.done?'line-through':'none'}}>{t.title}</div>{t.due&&<div style={{fontSize:11,color:days!==null&&days<=1?'#e02020':'#888'}}>{days===0?'Today':days===1?'Tomorrow':days<0?'Overdue':`Due ${t.due}`}</div>}</div>
                  <Badge p={t.priority}/>
                  <button onClick={()=>delTask(t.id)} style={{background:'none',border:'none',cursor:'pointer',color:'#ccc',fontSize:16}}>×</button>
                </div>
              );})}
          </div>
        </div>
        <div className="card">
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📊 Summary</div>
          <div style={{display:'grid', gap:10}} className="stats-grid">
            {[['Total',tasks.length,'#111'],['Active',tasks.filter(t=>!t.done).length,'#d97706'],['Done',tasks.filter(t=>t.done).length,'#16a34a'],['High Priority',tasks.filter(t=>t.priority==='High'&&!t.done).length,'#e02020']].map(([l,v,c])=>(
              <div key={l} style={{background:'#fafafa',borderRadius:10,padding:'14px 16px',textAlign:'center'}}><div style={{fontSize:24,fontWeight:800,color:c}}>{v}</div><div style={{fontSize:11,color:'#888',marginTop:4}}>{l}</div></div>
            ))}
          </div>
        </div>
      </div>}
      {tab==='notes'&&<div style={{display:'grid', gap:16}} className="rg-2">
        <div className="card">
          <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>📝 New Note</div>
          <FF label="Title"><input className="ag-input" value={nt} onChange={e=>setNt(e.target.value)} placeholder="Note title..."/></FF>
          <FF label="Content"><textarea className="ag-input" style={{resize:'vertical',minHeight:160}} value={nc} onChange={e=>setNc(e.target.value)} placeholder="Write your note..."/></FF>
          <button className="btn-red btn-full" onClick={()=>{if(!nt&&!nc)return;addNote({title:nt||'Untitled',content:nc});setNt('');setNc('');}}>💾 Save Note</button>
        </div>
        <div className="card">
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📚 All Notes ({notes.length})</div>
          {notes.length===0?<Empty icon="📝" text="No notes yet."/>:notes.map(n=><div key={n.id}>
            <div onClick={()=>setExp(exp===n.id?null:n.id)} style={{padding:'10px 0',borderBottom:'1px solid #f5f5f5',cursor:'pointer'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}><div style={{fontSize:13,fontWeight:600}}>{n.title}</div><button onClick={e=>{e.stopPropagation();delNote(n.id);}} style={{background:'none',border:'none',cursor:'pointer',color:'#ccc',fontSize:16}}>×</button></div>
              <div style={{fontSize:11,color:'#888',marginTop:2}}>{new Date(n.created_at).toLocaleDateString()}</div>
            </div>
            {exp===n.id&&<div style={{background:'#fafafa',padding:14,borderRadius:8,margin:'4px 0 8px',fontSize:13,lineHeight:1.6,whiteSpace:'pre-wrap'}}>{n.content}</div>}
          </div>)}
        </div>
      </div>}
    </div>
  );
}

// ─── Career Hub ────────────────────────────────────────────────────
function PgCareer({ profile, userMeta = {}, onLimitReached }) {
  const [tab, setTab] = useState('resume');
  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800 }}>💼 Career Hub</h1>
        <p style={{ color: '#888', fontSize: 13 }}>AI resume, LinkedIn, interview prep & job tracker.</p>
      </div>
      <Tabs tabs={[{ id: 'resume', label: '📄 Resume' }, { id: 'linkedin', label: '🔗 LinkedIn' }, { id: 'interview', label: '🎤 Interview' }, { id: 'jobs', label: '💼 Jobs' }, { id: 'advisor', label: '🤖 Advisor' }]} active={tab} onChange={setTab} />
      {tab === 'resume'    && <ResumeTab    profile={profile} userMeta={userMeta} onLimitReached={onLimitReached} />}
      {tab === 'linkedin'  && <LinkedInTab  profile={profile} userMeta={userMeta} onLimitReached={onLimitReached} />}
      {tab === 'interview' && <InterviewTab profile={profile} userMeta={userMeta} onLimitReached={onLimitReached} />}
      {tab === 'jobs'      && <JobsTab />}
      {tab === 'advisor'   && (
        <div className="card" style={{ height: 'calc(100vh - 280px)', display: 'flex', flexDirection: 'column' }}>
          <ChatBox
            sys={`Career advisor for ${profile.major} student. Goal: ${profile.careerGoal || 'TBD'}. Give concise, actionable advice.`}
            welcome={`Hi! I'm your Career Advisor.\n\nStudying **${profile.major}**. Ask me about:\n- Career paths & salary\n- Networking & interviews\n- Internship search\n- Skill development`}
            suggested={['What careers suit my major?', 'How to negotiate salary?', 'Best internships for students?', 'How to network effectively?']}
            userMeta={userMeta}
            onLimitReached={onLimitReached}
          />
        </div>
      )}
    </div>
  );
}

// Streaming output component — shows plain text while generating, switches to markdown when done
// This avoids running 6 regex operations on every single token
function StreamOut({ text, done }) {
  if (!text) return null;
  if (!done) {
    // Plain display during streaming — zero processing cost
    return <div style={{ fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>{text}</div>;
  }
  // Only parse markdown once, when complete
  return <AIOut text={text} />;
}

function ResumeTab({ profile, userMeta = {}, onLimitReached }) {
  const [f, setF]   = useState({ name: profile.name, major: profile.major, uni: profile.university || '', gpa: '', role: '', skills: '', exp: '', achieve: '' });
  const [out, setOut]   = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));

  async function build() {
    setBusy(true); setOut(''); setDone(false);
    await aiStream(
      [{ role: 'user', content: `Write a resume for:\nName: ${f.name} | Major: ${f.major} | University: ${f.uni} | GPA: ${f.gpa} | Target: ${f.role}\nSkills: ${f.skills}\nExperience: ${f.exp}\nAchievements: ${f.achieve}\n\nFormat: Header, Objective (2 lines), Education, Skills (bullet list), Experience (3 bullets each with metrics), Achievements. Use strong action verbs. Keep it to 1 page.` }],
      'Expert resume writer. Write concise, ATS-optimized resumes. No fluff.',
      p => { setOut(p); setDone(false); },
      full => {
        if (full === 'LIMIT_REACHED') { onLimitReached?.(); }
        else { setOut(full); setDone(true); }
        setBusy(false);
      },
      userMeta, false, 800  // Haiku + 800 tokens — enough for a 1-page resume, fast
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }} className="rg-2">
      <div className="card">
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>📝 Your Info</div>
        {[['name', 'Full Name'], ['major', 'Major'], ['uni', 'University'], ['gpa', 'GPA'], ['role', 'Target Role'], ['skills', 'Skills (comma separated)']].map(([k, l]) => (
          <FF key={k} label={l}><input className="ag-input" value={f[k]} onChange={e => set(k, e.target.value)} /></FF>
        ))}
        <FF label="Experience & Projects"><textarea className="ag-input" style={{ resize: 'vertical', minHeight: 80 }} value={f.exp} onChange={e => set('exp', e.target.value)} placeholder="Internships, projects, roles..." /></FF>
        <FF label="Achievements"><textarea className="ag-input" style={{ resize: 'vertical', minHeight: 60 }} value={f.achieve} onChange={e => set('achieve', e.target.value)} placeholder="Awards, clubs, leadership..." /></FF>
        <button className="btn-red btn-full" onClick={build} disabled={busy}>{busy ? <><Spin /> Building...</> : '✨ Build Resume'}</button>
      </div>
      <div className="card">
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
          📄 AI Resume
          {out && <>
            <button onClick={() => window.print()} style={{ padding: '5px 12px', border: '1px solid #ebebeb', borderRadius: 7, cursor: 'pointer', fontSize: 11, background: 'none', fontFamily: 'inherit' }}>🖨️ Print</button>
            <button onClick={() => navigator.clipboard.writeText(out)} style={{ padding: '5px 12px', border: '1px solid #ebebeb', borderRadius: 7, cursor: 'pointer', fontSize: 11, background: 'none', fontFamily: 'inherit' }}>📋 Copy</button>
          </>}
        </div>
        {busy && !out && <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#888', fontSize: 13 }}><Spin dark /> Writing your resume...</div>}
        {out ? <StreamOut text={out} done={done} /> : !busy && <Empty icon="📄" text="Fill in your info to generate a professional resume" />}
      </div>
    </div>
  );
}

function LinkedInTab({ profile, userMeta = {}, onLimitReached }) {
  const [role, setRole] = useState('');
  const [ind, setInd]   = useState('');
  const [uniq, setUniq] = useState('');
  const [out, setOut]   = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function gen() {
    setBusy(true); setOut(''); setDone(false);
    await aiStream(
      [{ role: 'user', content: `Write LinkedIn profile sections for:\nName: ${profile.name} | Major: ${profile.major} | Target: ${role} | Industry: ${ind}\nWhat makes them unique: ${uniq}\n\nWrite:\n1. Headline (under 120 chars, keyword-rich)\n2. About section (3 short paragraphs, first person, 150-200 words total)\n3. Top 10 skills to add\n4. One tip for their profile photo/banner` }],
      'LinkedIn profile expert. Be specific and punchy. No generic phrases.',
      p => { setOut(p); setDone(false); },
      full => {
        if (full === 'LIMIT_REACHED') { onLimitReached?.(); }
        else { setOut(full); setDone(true); }
        setBusy(false);
      },
      userMeta, false, 700  // 700 tokens — enough for all sections, no overrun
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }} className="rg-2">
      <div className="card">
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>🔗 Generate LinkedIn Profile</div>
        <FF label="Target Role"><input className="ag-input" value={role} onChange={e => setRole(e.target.value)} placeholder="Software Engineer" /></FF>
        <FF label="Industry"><input className="ag-input" value={ind} onChange={e => setInd(e.target.value)} placeholder="Technology, Finance..." /></FF>
        <FF label="What Makes You Unique?"><textarea className="ag-input" style={{ resize: 'vertical', minHeight: 90 }} value={uniq} onChange={e => setUniq(e.target.value)} placeholder="Your passions, unique projects, values..." /></FF>
        <button className="btn-red btn-full" onClick={gen} disabled={busy}>{busy ? <><Spin /> Generating...</> : '🔗 Generate LinkedIn Profile'}</button>
      </div>
      <div className="card">
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>✍️ Your LinkedIn Profile</div>
        {busy && !out && <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#888', fontSize: 13 }}><Spin dark /> Writing your profile...</div>}
        {out ? <StreamOut text={out} done={done} /> : !busy && <Empty icon="🔗" text="Fill in your details to generate your LinkedIn profile" />}
      </div>
    </div>
  );
}

function InterviewTab({ profile, userMeta = {}, onLimitReached }) {
  const [role, setRole] = useState('');
  const [type, setType] = useState('behavioral');
  const [out, setOut]   = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ]       = useState('');
  const [ans, setAns]   = useState('');
  const [fb, setFb]     = useState('');
  const [fbDone, setFbDone] = useState(false);
  const [fl, setFl]     = useState(false);

  async function gen() {
    setBusy(true); setOut(''); setDone(false);
    await aiStream(
      [{ role: 'user', content: `Give 5 ${type} interview questions for a ${role || profile.major + ' student'}.\nFor each: question + what the interviewer wants to hear (1 line) + STAR tip (1 line).` }],
      'Expert interview coach. Be direct and practical.',
      p => { setOut(p); setDone(false); },
      full => {
        if (full === 'LIMIT_REACHED') { onLimitReached?.(); }
        else { setOut(full); setDone(true); }
        setBusy(false);
      },
      userMeta, false, 600  // 5 questions fits in 600 tokens easily
    );
  }

  async function getFb() {
    if (!ans.trim()) return;
    setFl(true); setFb(''); setFbDone(false);
    await aiStream(
      [{ role: 'user', content: `Interview Q: "${q}"\nCandidate answer: "${ans}"\n\nGive: score /10, what worked, what to improve, a better version in 3 sentences.` }],
      'Interview coach. Give specific, fast feedback.',
      p => { setFb(p); setFbDone(false); },
      full => {
        if (full === 'LIMIT_REACHED') { onLimitReached?.(); }
        else { setFb(full); setFbDone(true); }
        setFl(false);
      },
      userMeta, false, 400  // feedback is short — 400 tokens, very fast
    );
  }

  return (
    <div style={{ display: 'grid', gap: 16 }} className="rg-2">
      <div className="card">
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>🎤 Mock Interview</div>
        <FF label="Role"><input className="ag-input" value={role} onChange={e => setRole(e.target.value)} placeholder="Software Engineer Intern" /></FF>
        <FF label="Interview Type">
          <select className="ag-input" value={type} onChange={e => setType(e.target.value)}>
            <option value="behavioral">Behavioral (STAR)</option>
            <option value="technical">Technical</option>
            <option value="general">General HR</option>
            <option value="case">Case Study</option>
          </select>
        </FF>
        <button className="btn-red btn-full" style={{ marginBottom: 14 }} onClick={gen} disabled={busy}>{busy ? <><Spin /> Generating...</> : '🎤 Generate 5 Questions'}</button>
        {busy && !out && <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#888', fontSize: 13 }}><Spin dark /> Preparing questions...</div>}
        {out && <StreamOut text={out} done={done} />}
      </div>
      <div className="card">
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>💬 Practice & Feedback</div>
        <FF label="Paste a Question"><input className="ag-input" value={q} onChange={e => setQ(e.target.value)} placeholder="Paste any interview question here..." /></FF>
        {q && <div style={{ background: '#fff5f5', border: '1px solid #ffd0d0', borderRadius: 8, padding: '10px 14px', marginBottom: 12, fontSize: 13, fontWeight: 600, color: '#e02020' }}>❓ {q}</div>}
        <FF label="Your Answer"><textarea className="ag-input" style={{ resize: 'vertical', minHeight: 110 }} value={ans} onChange={e => setAns(e.target.value)} placeholder="Type your answer using STAR: Situation, Task, Action, Result..." /></FF>
        <button className="btn-red btn-full" onClick={getFb} disabled={fl || !q || !ans.trim()}>{fl ? <><Spin /> Analysing...</> : '✨ Get AI Feedback'}</button>
        {fl && !fb && <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#888', fontSize: 13, marginTop: 12 }}><Spin dark /> Analysing your answer...</div>}
        {fb && <div style={{ marginTop: 14 }}><StreamOut text={fb} done={fbDone} /></div>}
      </div>
    </div>
  );
}

function JobsTab(){
  const [jobs,setJobs]=useState(()=>{try{return JSON.parse(localStorage.getItem('ajobs')||'[]')}catch{return []}});
  const [f,setF]=useState({company:'',role:'',status:'Applied',date:'',link:''});
  const [show,setShow]=useState(false);
  function save(u){setJobs(u);try{localStorage.setItem('ajobs',JSON.stringify(u))}catch{}}
  function add(){if(!f.company||!f.role)return;save([...jobs,{...f,id:Date.now()}]);setF({company:'',role:'',status:'Applied',date:'',link:''});setShow(false);}
  const colors={Applied:'#2563eb','Phone Screen':'#d97706',Interview:'#7c3aed',Offer:'#16a34a',Rejected:'#e02020'};
  return <div>
    <div style={{display:'flex',justifyContent:'space-between',marginBottom:16}}><span style={{fontSize:13,color:'#888'}}>{jobs.length} tracked</span><button className="btn-red" onClick={()=>setShow(s=>!s)}>{show?'Cancel':'+ Add Application'}</button></div>
    {show&&<div className="card" style={{marginBottom:16}}>
      <div style={{display:'grid', gap:12}} className="stats-grid">
        <FF label="Company"><input className="ag-input" value={f.company} onChange={e=>setF(x=>({...x,company:e.target.value}))} placeholder="Google, Amazon..."/></FF>
        <FF label="Role"><input className="ag-input" value={f.role} onChange={e=>setF(x=>({...x,role:e.target.value}))} placeholder="Software Engineer"/></FF>
        <FF label="Status"><select className="ag-input" value={f.status} onChange={e=>setF(x=>({...x,status:e.target.value}))}>{Object.keys(colors).map(s=><option key={s}>{s}</option>)}</select></FF>
        <FF label="Date Applied"><input className="ag-input" type="date" value={f.date} onChange={e=>setF(x=>({...x,date:e.target.value}))}/></FF>
      </div>
      <FF label="Job Link"><input className="ag-input" value={f.link} onChange={e=>setF(x=>({...x,link:e.target.value}))} placeholder="https://..."/></FF>
      <button className="btn-red" onClick={add}>Save</button>
    </div>}
    <div className="card">
      {jobs.length===0?<Empty icon="💼" text="No applications yet. Track your first!"/>:
        <table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr style={{borderBottom:'2px solid #ebebeb'}}>{['Company','Role','Status','Date',''].map(h=><th key={h} style={{textAlign:'left',padding:'8px 12px',fontSize:11,color:'#888',textTransform:'uppercase',letterSpacing:1}}>{h}</th>)}</tr></thead>
        <tbody>{jobs.map(j=><tr key={j.id} style={{borderBottom:'1px solid #f5f5f5'}}>
          <td style={{padding:'10px 12px',fontSize:13,fontWeight:600}}>{j.company}</td>
          <td style={{padding:'10px 12px',fontSize:13}}>{j.role}</td>
          <td style={{padding:'10px 12px'}}><span style={{fontSize:11,fontWeight:700,padding:'3px 9px',borderRadius:20,background:colors[j.status]+'20',color:colors[j.status]}}>{j.status}</span></td>
          <td style={{padding:'10px 12px',fontSize:12,color:'#888'}}>{j.date}</td>
          <td style={{padding:'10px 12px'}}>{j.link&&<a href={j.link} target="_blank" rel="noreferrer" style={{fontSize:12,color:'#2563eb',marginRight:10}}>View</a>}<button onClick={()=>save(jobs.filter(x=>x.id!==j.id))} style={{background:'none',border:'none',cursor:'pointer',color:'#ccc',fontSize:16}}>×</button></td>
        </tr>)}</tbody></table>}
    </div>
  </div>;
}

// ─── International Hub ─────────────────────────────────────────────
function PgIntl({ profile, userMeta={}, onLimitReached }){
  const [tab,setTab]=useState('visa');
  const sys=`You are an expert immigration advisor for international students. Status: ${profile.status}. Always recommend consulting DSO/attorney for official decisions.`;
  return <div>
    <div style={{marginBottom:22}}><h1 style={{fontSize:24,fontWeight:800}}>🌐 International Hub</h1><p style={{color:'#888',fontSize:13}}>Visa help, CPT/OPT, IELTS grading, embassy prep & scholarships — AI-powered.</p></div>
    <Tabs tabs={[{id:'visa',label:'🛂 Visa'},{id:'cptopt',label:'💼 CPT/OPT'},{id:'ielts',label:'📝 IELTS'},{id:'embassy',label:'🏛️ Embassy'},{id:'scholar',label:'🎓 Scholarships'}]} active={tab} onChange={setTab}/>
    {tab==='visa'&&<div className="card" style={{height:'calc(100vh - 280px)',display:'flex',flexDirection:'column'}}><div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:10,padding:'12px 16px',fontSize:13,color:'#1e40af',marginBottom:12}}>⚠️ General guidance only. Always consult your DSO for official decisions.</div><ChatBox sys={sys} welcome="👋 Visa & Immigration Assistant.\n\nAsk about F-1/J-1 visas, SEVIS, travel rules, maintaining student status." suggested={['How to maintain F-1 status?','Can I work off-campus on F-1?','What is SEVIS?','Travel on F-1 visa rules?']} userMeta={userMeta} onLimitReached={onLimitReached}/></div>}
    {tab==='cptopt'&&<div className="card" style={{height:'calc(100vh - 280px)',display:'flex',flexDirection:'column'}}><div style={{background:'#eff6ff',border:'1px solid #bfdbfe',borderRadius:10,padding:'12px 16px',fontSize:13,color:'#1e40af',marginBottom:12}}>💼 Always verify CPT/OPT details with your DSO before applying.</div><ChatBox sys={sys} welcome="💼 CPT/OPT Specialist.\n\nAsk about CPT, OPT, STEM extension, work authorisation rules." suggested={['Am I eligible for CPT?','How to apply for OPT?','What is STEM OPT extension?','Can I work while OPT pending?']} userMeta={userMeta} onLimitReached={onLimitReached}/></div>}
    {tab==='ielts'&&<IELTSTab userMeta={userMeta}/>}
    {tab==='embassy'&&<EmbassyTab userMeta={userMeta}/>}
    {tab==='scholar'&&<ScholarTab profile={profile} userMeta={userMeta}/>}
  </div>;
}

function IELTSTab({ userMeta={} }){
  const [prompt,setPrompt]=useState('');const [essay,setEssay]=useState('');const [out,setOut]=useState('');const [busy,setBusy]=useState(false);
  const prompts=['Some people think longer prison sentences reduce crime. Others believe there are better alternatives. Discuss both views.','In many countries, animals and plants are declining. Why? How can this be addressed?','Some argue an enjoyable job is more important than a high salary. Do you agree?'];
  async function grade(){if(!essay.trim())return;setBusy(true);setOut('');await aiStream([{role:'user',content:`Grade this IELTS Task 2 essay (0-9 scale).\nPrompt:${prompt||'General IELTS essay'}\nEssay(${essay.split(' ').filter(Boolean).length} words):\n${essay}\n\nScore all 4 criteria. Overall band. Specific feedback and improvements.`}],'You are a certified IELTS examiner. Grade accurately.',p=>setOut(p),()=>setBusy(false),userMeta);}
  return <div style={{display:'grid', gap:16}} className="rg-2">
    <div>
      <div className="card" style={{marginBottom:14}}><div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📝 Sample Prompts</div>{prompts.map((p,i)=><div key={i} onClick={()=>setPrompt(p)} style={{padding:'10px 0',borderBottom:'1px solid #f5f5f5',fontSize:12,cursor:'pointer',color:prompt===p?'#e02020':'#333',lineHeight:1.5}}>#{i+1} {p.slice(0,70)}...</div>)}</div>
      <div className="card">
        <FF label="Prompt"><textarea className="ag-input" style={{resize:'vertical',minHeight:80}} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="IELTS question..."/></FF>
        <FF label={`Essay (${essay.split(' ').filter(Boolean).length} words)`}><textarea className="ag-input" style={{resize:'vertical',minHeight:200}} value={essay} onChange={e=>setEssay(e.target.value)} placeholder="Write 250+ words..."/></FF>
        <button className="btn-red btn-full" onClick={grade} disabled={busy}>{busy?<><Spin/>Grading...</>:'📊 Grade My Essay'}</button>
      </div>
    </div>
    <div className="card">{out?<AIOut text={out}/>:<Empty icon="📊" text="Write your essay to get detailed IELTS band scoring"/>}</div>
  </div>;
}

function EmbassyTab({ userMeta={} }){
  const [country,setCountry]=useState('USA');const [out,setOut]=useState('');const [busy,setBusy]=useState(false);
  const [q,setQ]=useState('');const [ans,setAns]=useState('');const [fb,setFb]=useState('');const [fl,setFl]=useState(false);
  const qs=['Why study in the USA?','Why this university?','How will you fund your education?','Plans after graduation?','Family in the USA?','Why not study in home country?'];
  // Reduced from 15 questions to 8, removed verbose instructions — 3x faster
  async function prep(){setBusy(true);setOut('');await aiStream([{role:'user',content:`${country} student visa interview: list 8 key questions with ideal short answers, plus a documents checklist.`}],'You are a visa interview coach. Be concise and practical.',p=>setOut(p),()=>setBusy(false),userMeta);}
  async function getFb(){if(!ans.trim())return;setFl(true);setFb('');await aiStream([{role:'user',content:`Question:"${q}" Answer:"${ans}" — Score /10, strengths, 1 improvement, better answer.`}],'You are a visa interview coach.',p=>setFb(p),()=>setFl(false),userMeta);}
  return <div style={{display:'grid', gap:16}} className="rg-2">
    <div className="card">
      <FF label="Embassy"><select className="ag-input" value={country} onChange={e=>setCountry(e.target.value)}><option>USA</option><option>UK</option><option>Canada</option><option>Australia</option><option>Germany</option></select></FF>
      <button className="btn-red btn-full" style={{ marginBottom:16 }} onClick={prep} disabled={busy}>{busy?<><Spin/>Loading...</>:'📋 Get Questions & Tips'}</button>
      {out&&<AIOut text={out}/>}
    </div>
    <div className="card">
      <FF label="Pick a Question"><select className="ag-input" value={q} onChange={e=>setQ(e.target.value)}><option value="">-- Select --</option>{qs.map(x=><option key={x} value={x}>{x}</option>)}</select></FF>
      {q&&<div style={{background:'#fff5f5',border:'1px solid #ffd0d0',borderRadius:8,padding:12,marginBottom:12,fontSize:13,fontWeight:600,color:'#e02020'}}>❓ {q}</div>}
      <FF label="Your Answer"><textarea className="ag-input" style={{resize:'vertical',minHeight:120}} value={ans} onChange={e=>setAns(e.target.value)} placeholder="How you'd answer in the interview..."/></FF>
      <button className="btn-red btn-full" onClick={getFb} disabled={fl}>{fl?<><Spin/>Analysing...</>:'💬 Get Feedback'}</button>
      {fb&&<div style={{marginTop:14}}><AIOut text={fb}/></div>}
    </div>
  </div>;
}

function ScholarTab({ profile, userMeta={} }){
  const [field,setField]=useState(profile.major||'');const [level,setLevel]=useState('Undergraduate');const [out,setOut]=useState('');const [busy,setBusy]=useState(false);
  async function find(){setBusy(true);setOut('');await aiStream([{role:'user',content:`Top 8 scholarships for ${level} ${field||'international'} student. Name, amount, deadline, apply link.`}],'You are a scholarship advisor. Be specific and concise.',p=>setOut(p),()=>setBusy(false),userMeta);}
  return <div style={{display:'grid', gap:16}} className="rg-2">
    <div className="card">
      <FF label="Field of Study"><input className="ag-input" value={field} onChange={e=>setField(e.target.value)} placeholder="Computer Science, Business..."/></FF>
      <FF label="Level"><select className="ag-input" value={level} onChange={e=>setLevel(e.target.value)}><option>Undergraduate</option><option>Graduate</option><option>PhD</option><option>MBA</option></select></FF>
      <button className="btn-red btn-full" onClick={find} disabled={busy}>{busy?<><Spin/>Searching...</>:'🔍 Find Scholarships'}</button>
    </div>
    <div className="card">{out?<AIOut text={out}/>:<Empty icon="🎓" text="Find scholarships matching your profile"/>}</div>
  </div>;
}

// ─── Resources ─────────────────────────────────────────────────────
function PgResources({ profile, userMeta={}, onLimitReached }){
  const [sub,setSub]=useState('');const [type,setType]=useState('youtube');const [out,setOut]=useState('');const [busy,setBusy]=useState(false);const [custom,setCustom]=useState('');
  const types=[{id:'youtube',label:'▶️ YouTube'},{id:'tools',label:'🛠️ Tools'},{id:'books',label:'📚 Books'},{id:'coding',label:'💻 Coding'},{id:'custom',label:'🤖 Ask AI'}];
  async function find(){
    const s=sub||profile.major||'academics';
    const ps={youtube:`Top 10 YouTube channels for studying ${s}. Name, what it covers, why great.`,tools:`Best study tools for ${s} students. Free and paid. Name, cost, best feature.`,books:`Best books/textbooks for ${s} university students. Title, author, where to find cheaply.`,coding:`Best free coding resources for ${s}. Platforms, courses, practice sites.`,custom:custom};
    setBusy(true);setOut('');await aiStream([{role:'user',content:ps[type]}],'You are an expert academic resource curator. Be specific with names.',p=>setOut(p),()=>setBusy(false),userMeta);
  }
  return <div>
    <div style={{marginBottom:22}}><h1 style={{fontSize:24,fontWeight:800}}>📚 Resource Library</h1><p style={{color:'#888',fontSize:13}}>AI-curated resources — YouTube, tools, books, coding platforms and more.</p></div>
    <div className="card" style={{marginBottom:20}}>
      <div style={{display:'flex',gap:10}}>
        <input className="ag-input" style={{flex:1}} value={sub} onChange={e=>setSub(e.target.value)} placeholder={`e.g. ${profile.major||'Machine Learning, Chemistry'}...`} onKeyDown={e=>e.key==='Enter'&&find()}/>
        <button className="btn-red" onClick={find} disabled={busy}>{busy?<Spin/>:'Find Resources'}</button>
      </div>
    </div>
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:20}}>{types.map(t=><button key={t.id} onClick={()=>setType(t.id)} style={{padding:'8px 16px',borderRadius:9,fontSize:13,cursor:'pointer',background:type===t.id?'#e02020':'#fff',color:type===t.id?'#fff':'#888',border:'1px solid #ebebeb',fontFamily:'inherit',fontWeight:600}}>{t.label}</button>)}</div>
    {type==='custom'&&<div className="card" style={{marginBottom:16}}><textarea className="ag-input" style={{resize:'vertical',marginBottom:10,minHeight:80}} value={custom} onChange={e=>setCustom(e.target.value)} placeholder="e.g. Best free resources to learn React in 30 days..."/><button className="btn-red" onClick={find} disabled={busy}>{busy?<><Spin/>Searching...</>:'🤖 Get Recommendations'}</button></div>}
    <div className="card">{busy&&!out?<div style={{display:'flex',alignItems:'center',gap:12,color:'#888',fontSize:13,padding:20}}><Spin dark/>Finding best resources...</div>:out?<AIOut text={out}/>:<Empty icon="📚" text="Enter a subject and click Find Resources"/>}</div>
  </div>;
}

// ─── AI Assistant ──────────────────────────────────────────────────
function PgAssistant({ profile, userMeta={}, onLimitReached }){
  const sys=`You are AGRYX, an intelligent AI assistant for students. Student: ${profile.name}, ${profile.major} at ${profile.university||'university'}, ${profile.year}, status: ${profile.status}. Help with homework, essays, coding, math, career advice, study strategies. Be thorough, clear, encouraging. Use markdown.`;
  return <div>
    <div style={{marginBottom:22}}><h1 style={{fontSize:24,fontWeight:800}}>🤖 AI Assistant</h1><p style={{color:'#888',fontSize:13}}>Ask anything — homework, concepts, career, coding, writing, study tips. 24/7.</p></div>
    <div className="card" style={{height:'calc(100vh - 200px)',display:'flex',flexDirection:'column'}}>
      <ChatBox sys={sys} welcome={`Hi ${profile.name}! 👋 I'm your AGRYX AI Assistant.\n\n**I can help with:**\n- 📚 Homework & assignments\n- 🔢 Math problems step by step\n- ✍️ Essay & writing help\n- 💻 Coding & debugging\n- 💼 Career advice\n- 🌐 International student questions\n- 📅 Study strategies\n\nWhat do you need help with?`} suggested={['Help me understand this concept','Write an essay outline','Debug my code','Study strategy for finals','Career paths for my major']} userMeta={userMeta} onLimitReached={onLimitReached}/>
    </div>
  </div>;
}

// ─── Settings ──────────────────────────────────────────────────────
function PgSettings({profile,saveProfile,deadlines,tasks,notes,onSignOut}){
  const [f,setF]=useState({name:profile.name,major:profile.major,university:profile.university,year:profile.year,status:profile.status,careerGoal:profile.careerGoal,courses:(profile.courses||[]).join(', ')});
  const [saved,setSaved]=useState(false);
  const set=(k,v)=>setF(x=>({...x,[k]:v}));
  async function save(){await saveProfile({...f,courses:f.courses.split(',').map(c=>c.trim()).filter(Boolean)});setSaved(true);setTimeout(()=>setSaved(false),2500);}
  return <div>
    <div style={{marginBottom:22}}><h1 style={{fontSize:24,fontWeight:800}}>⚙️ Settings</h1><p style={{color:'#888',fontSize:13}}>Customise your profile so AI gives personalised help.</p></div>
    <div style={{display:'grid', gap:16}} className="rg-2">
      <div className="card">
        <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>👤 Your Profile</div>
        <FF label="Full Name"><input className="ag-input" value={f.name} onChange={e=>set('name',e.target.value)}/></FF>
        <FF label="Major"><input className="ag-input" value={f.major} onChange={e=>set('major',e.target.value)}/></FF>
        <FF label="University"><input className="ag-input" value={f.university} onChange={e=>set('university',e.target.value)}/></FF>
        <FF label="Year"><select className="ag-input" value={f.year} onChange={e=>set('year',e.target.value)}><option>Freshman</option><option>Sophomore</option><option>Junior</option><option>Senior</option><option>Graduate</option><option>PhD</option></select></FF>
        <FF label="Status"><select className="ag-input" value={f.status} onChange={e=>set('status',e.target.value)}><option>Domestic Student</option><option>International Student (F-1)</option><option>International Student (J-1)</option><option>Permanent Resident</option></select></FF>
        <FF label="Career Goal"><input className="ag-input" value={f.careerGoal} onChange={e=>set('careerGoal',e.target.value)} placeholder="e.g. Software Engineer at Google"/></FF>
        <FF label="Courses (comma separated)"><input className="ag-input" value={f.courses} onChange={e=>set('courses',e.target.value)} placeholder="Data Structures, Calculus II..."/></FF>
        <button className="btn-red btn-full" onClick={save}>{saved?'✅ Saved!':'💾 Save Profile'}</button>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:16}}>
        <div className="card">
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>📊 Stats</div>
          <div style={{display:'grid', gap:10}} className="stats-grid">
            {[['Deadlines',deadlines.length],['Tasks',tasks.length],['Notes',notes.length],['Completed',tasks.filter(t=>t.done).length]].map(([l,v])=>(
              <div key={l} style={{background:'#fafafa',borderRadius:10,padding:'14px 16px',textAlign:'center'}}><div style={{fontSize:24,fontWeight:800}}>{v}</div><div style={{fontSize:11,color:'#888',marginTop:4}}>{l}</div></div>
            ))}
          </div>
        </div>
        <div className="card">
          <div style={{fontSize:14,fontWeight:700,marginBottom:12}}>🔑 Account</div>
          <button onClick={onSignOut} style={{width:'100%',padding:11,background:'#fff',border:'1.5px solid #ebebeb',borderRadius:9,cursor:'pointer',fontSize:13,fontFamily:'inherit',fontWeight:600,color:'#555'}}>🚪 Sign Out</button>
        </div>
        <div className="card">
          <div style={{fontSize:14,fontWeight:700,marginBottom:10}}>👑 AGRYX Pro</div>
          <div style={{fontSize:13,color:'#888',lineHeight:1.6,marginBottom:14}}>Upgrade for unlimited AI, priority responses & premium features.</div>
          {['✅ Unlimited AI messages','✅ Advanced resume templates','✅ Priority AI responses','✅ Advanced analytics'].map(f=><div key={f} style={{fontSize:12,marginBottom:6}}>{f}</div>)}
          <button className="btn-red btn-full" style={{ marginTop:12 }}>🚀 Coming Soon</button>
        </div>
      </div>
    </div>
  </div>;
}
