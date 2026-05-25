# TODO - Wrapstore Guided Product Creator

## 1. Repository and Shopify configuration
- [x] Reuse the existing Shopify embedded React Router app in this repository.
- [x] Keep Prisma/Postgres and Render deployment as the production baseline.
- [x] Move API version to the latest stable supported by installed Shopify packages (`2026-04`) while allowing `SHOPIFY_API_VERSION` to override it.
- [x] Update required scopes for products, files, metaobjects, and existing cart-transform functionality.

## 2. Database
- [x] Extend Prisma schema with `ProductDraft`, `ProductDraftImage`, and `OperationLog`.
- [x] Add a Prisma migration compatible with Supabase Postgres.
- [x] Persist Shopify OAuth sessions through the existing Prisma session adapter.

## 3. Domain validation and utilities
- [x] Add Zod schemas for product draft and create-product payloads.
- [x] Add helpers for filename color normalization, slugify handles, variant matrix generation, duplicate detection, and product specs mapping.
- [x] Add unit tests for slugify, variant generation, Pellicole validation, Product Specs mapping, duplicate colors/SKUs.

## 4. Shopify service layer
- [x] Add service modules under `app/services/shopify`.
- [x] Query collections and identify manual vs smart collections.
- [x] Resolve `custom.altezza` metafield references and metaobject values.
- [x] Upload images/PDF through staged uploads and `fileCreate`, then poll until READY.
- [x] Create products, options, variants, media associations, metafields, metaobjects, and collection assignment through GraphQL Admin API.
- [x] Log GraphQL/user errors in `OperationLog`.

## 5. Embedded UI
- [x] Replace the `/app` home with an Italian “Nuovo prodotto” wizard.
- [x] Implement collection combobox, base product form, Pellicole flow, Accessori flow, and review step.
- [x] Add drag/drop image uploads, previews, editable color/SKU rows, height multi-select, PDF upload, and loading/error/success states.
- [x] Autosave temporary drafts so refresh does not lose data.

## 6. Documentation and verification
- [x] Update README with local setup, Shopify app setup, scopes, Supabase, Prisma migrations, Render deploy, limitations, full test flow, and metafield/metaobject troubleshooting.
- [x] Run tests, typecheck, lint, build.
