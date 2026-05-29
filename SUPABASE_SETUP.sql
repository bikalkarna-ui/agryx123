-- ══════════════════════════════════════════════════════
-- AGRYX v2 — Run this in Supabase SQL Editor:
-- https://supabase.com/dashboard/project/xuycmlqggrtupmpqmexx/sql
-- ══════════════════════════════════════════════════════

-- 1. PROFILES (includes plan + chat tracking)
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  name text,
  major text,
  university text,
  year text,
  status text,
  career_goal text,
  courses text[] default '{}',
  plan text default 'free',
  chat_count integer default 0,
  plan_expires timestamptz,
  stripe_customer text,
  updated_at timestamptz default now()
);

-- 2. DEADLINES
create table if not exists public.deadlines (
  id text primary key,
  user_id uuid references auth.users on delete cascade,
  title text not null,
  type text default 'Assignment',
  date text,
  priority text default 'Medium',
  points text,
  created_at timestamptz default now()
);

-- 3. TASKS
create table if not exists public.tasks (
  id text primary key,
  user_id uuid references auth.users on delete cascade,
  title text not null,
  priority text default 'Medium',
  due text,
  done boolean default false,
  created_at timestamptz default now()
);

-- 4. NOTES
create table if not exists public.notes (
  id text primary key,
  user_id uuid references auth.users on delete cascade,
  title text,
  content text,
  created_at timestamptz default now()
);

-- 5. Row Level Security
alter table public.profiles  enable row level security;
alter table public.deadlines enable row level security;
alter table public.tasks     enable row level security;
alter table public.notes     enable row level security;

-- 6. Policies
drop policy if exists "own" on public.profiles;
drop policy if exists "own" on public.deadlines;
drop policy if exists "own" on public.tasks;
drop policy if exists "own" on public.notes;

create policy "own" on public.profiles  for all using (auth.uid() = id);
create policy "own" on public.deadlines for all using (auth.uid() = user_id);
create policy "own" on public.tasks     for all using (auth.uid() = user_id);
create policy "own" on public.notes     for all using (auth.uid() = user_id);

-- 7. Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, plan, chat_count)
  values (new.id, new.raw_user_meta_data->>'name', 'free', 0)
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 8. Admin: give Bikal full access (run after you log in once)
-- UPDATE public.profiles SET plan = 'admin' WHERE id = (SELECT id FROM auth.users WHERE email = 'bikalkarna@gmail.com');
