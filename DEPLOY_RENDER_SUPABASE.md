# Deploy su Render Free + Supabase Free

Questa app Shopify usa Supabase Postgres per salvare le sessioni OAuth e Render per servire l'interfaccia embedded nell'admin Shopify.

## 1. Supabase

1. Crea un progetto su Supabase.
2. Vai in **Project Settings > Database**.
3. Copia due connection string:
   - **Transaction pooler** per `DATABASE_URL`
   - **Direct connection** per `DIRECT_URL`
4. Sostituisci `[PASSWORD]` con la password database del progetto.

Esempio:

```env
DATABASE_URL=postgresql://postgres.[PROJECT_REF]:[PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1
DIRECT_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT_REF].supabase.co:5432/postgres
```

## 2. Render

1. Pubblica questo progetto su GitHub.
2. In Render scegli **New > Blueprint** e collega il repository.
3. Render leggerà `render.yaml` e creerà il web service free.
4. Inserisci queste variabili ambiente:

```env
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SCOPES=read_products,write_products,read_files,write_files,read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions,read_cart_transforms,write_cart_transforms
SHOPIFY_APP_URL=https://your-render-service.onrender.com
SHOPIFY_API_VERSION=2026-04
DATABASE_URL=
DIRECT_URL=
MAX_PRODUCT_IMAGES=24
MAX_PRODUCT_PDF_MB=20
```

Usa il dominio effettivo Render in `SHOPIFY_APP_URL`.

## 3. Shopify

Il dominio Render deve combaciare con `shopify.app.toml`:

```toml
application_url = "https://your-render-service.onrender.com"

[auth]
redirect_urls = [
  "https://your-render-service.onrender.com/auth/callback",
  "https://your-render-service.onrender.com/auth/shopify/callback",
  "https://your-render-service.onrender.com/api/auth/callback"
]
```

Se il dominio Render è diverso, aggiorna `shopify.app.toml` e poi esegui:

```bash
shopify app deploy
```

## 4. Note sul piano free

Render Free va in sleep dopo un periodo di inattività. Quando riapri l'app da Shopify Admin, il primo caricamento può richiedere circa un minuto.
