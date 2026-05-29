export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');

    if (!file) {
      return new Response(JSON.stringify({ error: 'No file uploaded' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Use pdf-parse to extract text
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(buffer);

    return new Response(JSON.stringify({ text: data.text, pages: data.numpages }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Could not parse PDF: ' + err.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
}
