# Wrapstore Product Creator

Shopify embedded app per creare prodotti Wrapstore in modo guidato dall'admin Shopify. L'app usa React Router, Node.js/TypeScript, Shopify GraphQL Admin API, Prisma e Supabase Postgres. Il deploy e pensato per Render Free.

## Funzionalita

- Wizard “Nuovo prodotto” in italiano.
- Lettura collezioni Shopify e warning per collezioni smart/automatiche.
- Creazione prodotti `DRAFT` o `ACTIVE`.
- Flusso Pellicole con immagini colore, SKU colore, opzioni `Colore` e `Altezza`, varianti generate come matrice colore x altezza.
- Nome colore precompilato dal filename, per esempio `Rosso-Mattone.jpg` diventa `Rosso Mattone`.
- Upload immagini via staged upload e media prodotto con alt text uguale al nome colore. Shopify non espone un vero `title` separato per immagine prodotto: l'app usa l'alt text come fallback documentato.
- Upload PDF su Shopify Files e collegamento a `custom.file_info_del_prodotto`.
- Creazione metaobject entries per `custom.product_specs`.
- Flusso Accessori estendibile con immagini, SKU opzionale e PDF.
- Bozze temporanee in Supabase Postgres.
- Log tecnici in `OperationLog`.

## Stack

- Shopify embedded app React Router.
- Backend Node.js/TypeScript.
- Prisma ORM.
- Supabase Postgres.
- Shopify GraphQL Admin API, senza REST per prodotti/media.
- API default: `2026-04`, sovrascrivibile con `SHOPIFY_API_VERSION`.

## Setup Locale

```bash
npm install
npm run prisma -- generate
npm run setup
npm run dev
```

Per sviluppo senza chiamare Shopify in creazione prodotto puoi usare:

```env
DEV_MOCK_SHOPIFY=true
```

Il mock e dietro flag e non viene usato in produzione.

## App Shopify

1. Crea o collega una app Shopify tramite Shopify CLI.
2. Imposta l'app come embedded.
3. Aggiorna gli URL nel Partner Dashboard o con `shopify app deploy`.
4. Installa l'app sullo store `wrapstore.it` o sullo shop di test.

Scope richiesti:

```env
SCOPES=read_products,write_products,read_files,write_files,read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions,read_cart_transforms,write_cart_transforms
```

Gli scope `read_cart_transforms` e `write_cart_transforms` restano per compatibilita con la funzione SQM gia presente nel progetto. Per il product creator servono soprattutto prodotti, file, metaobject e metaobject definitions.

## Supabase

1. Crea un progetto Supabase.
2. Copia la connection string del pooler in `DATABASE_URL`.
3. Copia la direct connection in `DIRECT_URL`.
4. Esegui:

```bash
npm run prisma -- migrate deploy
npm run prisma -- generate
```

Tabelle create:

- `Session`: storage OAuth Shopify.
- `ProductDraft`: bozza principale del wizard.
- `ProductDraftImage`: immagini temporanee con colore/SKU e preview.
- `OperationLog`: log tecnici delle operazioni Shopify.

## Variabili Ambiente

```env
SHOPIFY_API_KEY=
SHOPIFY_API_SECRET=
SHOPIFY_APP_URL=https://your-render-service.onrender.com
SHOPIFY_API_VERSION=2026-04
SCOPES=read_products,write_products,read_files,write_files,read_metaobjects,write_metaobjects,read_metaobject_definitions,write_metaobject_definitions,read_cart_transforms,write_cart_transforms
DATABASE_URL=
DIRECT_URL=

PRODUCT_SPECS_METAOBJECT_TYPE=
PRODUCT_SPECS_TITLE_FIELD=
PRODUCT_SPECS_VALUE_FIELD=
PRODUCT_SPECS_SKU_FIELD=
ALTEZZA_METAOBJECT_TYPE=

MAX_PRODUCT_IMAGES=24
MAX_PRODUCT_PDF_MB=20
DEV_MOCK_SHOPIFY=false
```

`PRODUCT_SPECS_*` serve quando Shopify non espone automaticamente le chiavi della metaobject definition o quando la definition usa nomi diversi da `title`/`titolo`, `value`/`valore`, `sku`.

`ALTEZZA_METAOBJECT_TYPE` serve se `custom.altezza` non permette di risalire automaticamente al tipo metaobject referenziato.

## Deploy Render Free

Il file `render.yaml` definisce:

- build command: `npm install && npm run render-build`
- start command: `npm run render-start`
- Node `22.18.0`
- piano free

Passi:

1. Pubblica il repository su GitHub.
2. In Render crea un nuovo Blueprint dal repository.
3. Inserisci le variabili ambiente richieste.
4. Copia il dominio Render in `SHOPIFY_APP_URL`.
5. Aggiorna `application_url` e `redirect_urls` in `shopify.app.toml`.
6. Esegui `npm run deploy` o `shopify app deploy`.

Render Free puo andare in sleep. Le sessioni OAuth restano in Supabase, quindi il cold start rallenta il primo caricamento ma non dovrebbe rompere l'accesso.

## Metafield e Metaobject Attesi

### `custom.altezza`

- Owner: Product.
- Tipo atteso: `list.metaobject_reference` o compatibile.
- Deve puntare a metaobject entries che rappresentano le altezze.
- Se il tipo non viene risolto, imposta `ALTEZZA_METAOBJECT_TYPE`.

### `custom.file_info_del_prodotto`

- Owner: Product.
- Tipo atteso: `file_reference`.
- L'app carica il PDF su Shopify Files, attende `READY`, poi imposta il metafield.

### `custom.product_specs`

- Owner: Product.
- Tipo atteso: `list.metaobject_reference`.
- L'app interroga la definition per capire il tipo metaobject e i campi.
- Fallback configurabile via:
  - `PRODUCT_SPECS_METAOBJECT_TYPE`
  - `PRODUCT_SPECS_TITLE_FIELD`
  - `PRODUCT_SPECS_VALUE_FIELD`
  - `PRODUCT_SPECS_SKU_FIELD`

Handle generato: `slugify("{titolo_specifica}_{sku_prodotto}")`, con underscore.

## Come Testare il Flusso Completo

1. Avvia `npm run dev`.
2. Apri l'app dall'admin Shopify.
3. Vai su “Nuovo prodotto”.
4. Scegli una collezione manuale.
5. Inserisci titolo, categoria `Pellicole`, brand.
6. Carica immagini PNG/JPG/WEBP e verifica nome colore precompilato.
7. Seleziona una o piu altezze.
8. Carica un PDF info prodotto.
9. Compila alcune specifiche.
10. Controlla la review e clicca “Crea prodotto”.
11. Apri il link prodotto Shopify e verifica:
    - status `DRAFT` salvo toggle publish;
    - opzioni `Colore` e `Altezza`;
    - varianti generate;
    - media prodotto;
    - PDF su `custom.file_info_del_prodotto`;
    - metaobject entries e `custom.product_specs`;
    - prodotto aggiunto alla collezione manuale.

## Test e Build

```bash
npm test
npm run typecheck
npm run build
```

I test coprono slugify handle, generazione varianti, validazione payload Pellicole, mapping Product Specs e duplicati colore/SKU.

## Limitazioni Note

- Shopify non ha un campo `title` separato affidabile per ogni immagine prodotto: viene usato `alt`.
- Le collezioni smart possono rifiutare `collectionAddProducts`; l'app mostra stato parziale e logga l'errore.
- Le bozze salvano i file come data URL nel database per preservare il form dopo refresh. Mantieni limiti prudenti su immagini e PDF.
- Se la metaobject definition di Product Specs ha campi obbligatori non mappati, Shopify puo rifiutare la creazione: configura le env `PRODUCT_SPECS_*`.

## Troubleshooting

- **OAuth loop o redirect errato**: verifica `SHOPIFY_APP_URL`, `application_url` e `redirect_urls`.
- **Session table missing**: esegui `npm run prisma -- migrate deploy`.
- **Altezze non caricate**: controlla `custom.altezza`, scope metaobjects e `ALTEZZA_METAOBJECT_TYPE`.
- **PDF non collegato**: controlla che `custom.file_info_del_prodotto` sia `file_reference`.
- **Specifiche non create**: controlla tipo di `custom.product_specs`, campi metaobject e env `PRODUCT_SPECS_*`.
- **Prodotto creato parzialmente**: guarda `OperationLog` in Supabase per il dettaglio tecnico.
