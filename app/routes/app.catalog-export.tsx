import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  fetchProductCatalog,
  productCatalogToCsv,
  type ProductCatalogItem,
} from "../services/shopify/catalog-export.server";

type LoaderData = {
  generatedAt: string;
  products: ProductCatalogItem[];
  shop: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const products = await fetchProductCatalog(admin);
  const url = new URL(request.url);

  if (url.searchParams.get("format") === "csv") {
    return new Response(productCatalogToCsv(products), {
      headers: {
        "Content-Disposition": `attachment; filename="${csvFileName(session.shop)}"`,
        "Content-Type": "text/csv; charset=utf-8",
      },
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    products,
    shop: session.shop,
  } satisfies LoaderData;
};

export default function CatalogExport() {
  const { generatedAt, products, shop } = useLoaderData() as LoaderData;
  const generatedLabel = new Intl.DateTimeFormat("it-IT", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(generatedAt));

  return (
    <s-page heading="Export catalogo">
      <style>{styles}</style>

      <main className="catalog-export">
        <header className="catalog-export__header">
          <div>
            <p className="eyebrow">{shop}</p>
            <h1>Lista prodotti Shopify</h1>
            <p className="muted">
              {products.length} prodotti caricati. Ultimo aggiornamento locale: {generatedLabel}.
            </p>
          </div>
          <div className="actions">
            <a className="button" href="/app/catalog-export?format=csv">
              Scarica CSV
            </a>
            <button onClick={() => window.location.reload()} type="button">
              Aggiorna
            </button>
          </div>
        </header>

        <section className="panel">
          {products.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Titolo</th>
                    <th>Handle</th>
                    <th>ID prodotto</th>
                    <th>GraphQL ID</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id}>
                      <td>{product.title}</td>
                      <td>{product.handle}</td>
                      <td>{product.numericId}</td>
                      <td className="gid">{product.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">Nessun prodotto trovato nel catalogo.</p>
          )}
        </section>
      </main>
    </s-page>
  );
}

function csvFileName(shop: string) {
  const date = new Date().toISOString().slice(0, 10);
  return `${shop.replace(/[^a-z0-9.-]/gi, "-")}-prodotti-${date}.csv`;
}

const styles = `
  .catalog-export { max-width: 1180px; margin: 0 auto; padding: 18px; color: #202223; }
  .catalog-export__header { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; margin-bottom: 18px; }
  .catalog-export h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: 0; }
  .eyebrow { margin: 0 0 4px; font-size: 12px; text-transform: uppercase; color: #616a75; font-weight: 700; }
  .muted, .empty { color: #616a75; margin: 0; }
  .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
  .button, button { border: 1px solid #c9ced6; background: #fff; color: #202223; padding: 10px 14px; border-radius: 6px; font: inherit; font-weight: 700; cursor: pointer; text-decoration: none; line-height: 1.2; }
  .button { background: #008060; border-color: #008060; color: #fff; }
  .panel { background: #fff; border: 1px solid #dfe3e8; border-radius: 8px; padding: 0; overflow: hidden; }
  .table-wrap { overflow: auto; max-height: calc(100vh - 260px); }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { border-top: 1px solid #e1e5ea; text-align: left; padding: 11px 12px; vertical-align: top; }
  th { background: #f7f8f9; color: #3f4750; font-weight: 750; position: sticky; top: 0; z-index: 1; }
  tbody tr:first-child td { border-top: 0; }
  .gid { color: #616a75; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; white-space: nowrap; }
  .empty { padding: 18px; }
  @media (max-width: 760px) {
    .catalog-export { padding: 12px; }
    .catalog-export__header { display: grid; }
    .actions { justify-content: stretch; }
    .button, button { width: 100%; text-align: center; box-sizing: border-box; }
  }
`;

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
