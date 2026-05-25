import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop") || url.searchParams.get("host")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Wrapstore Product Creator</h1>
        <p className={styles.text}>
          Crea prodotti Shopify in modo guidato, con varianti, media, metafield e metaobject.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>es. wowstampa.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Wizard guidato</strong>. Collezione, dati base, media, altezze e review finale.
          </li>
          <li>
            <strong>Pellicole e accessori</strong>. Flussi separati, pensati per il catalogo Wrapstore.
          </li>
          <li>
            <strong>Custom data Shopify</strong>. Salva file, specifiche e riferimenti dove il tema puo leggerli.
          </li>
        </ul>
      </div>
    </div>
  );
}
