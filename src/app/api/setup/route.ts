import { readFileSync } from 'fs';
import { join } from 'path';
import { NextRequest, NextResponse } from 'next/server';
import pg from 'pg';

export async function GET(request: NextRequest) {
  const secret = request.nextUrl.searchParams.get('secret');
  if (!secret || secret !== process.env.SETUP_SECRET) {
    return NextResponse.json({ error: 'Secret invalide' }, { status: 401 });
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return NextResponse.json(
      { error: 'DATABASE_URL manquant dans Vercel' },
      { status: 500 },
    );
  }

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    const check = await client.query(
      "SELECT to_regclass('public.statements') AS tbl",
    );
    if (check.rows[0]?.tbl) {
      return NextResponse.json({
        ok: true,
        message: 'Base de données déjà configurée ✓',
      });
    }

    const sql = readFileSync(
      join(process.cwd(), 'supabase', 'schema.sql'),
      'utf8',
    );
    await client.query(sql);

    return NextResponse.json({
      ok: true,
      message: 'Base de données initialisée avec succès ✓ Tu peux te connecter et uploader tes CSV.',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Erreur inconnue';
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    await client.end().catch(() => {});
  }
}
