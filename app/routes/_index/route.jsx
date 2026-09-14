import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Import external orders reliably</h1>
        <p className={styles.text}>
          OrderRelay validates CSV orders against your Shopify catalog and
          creates them through a durable, trackable workflow.
        </p>
        {showForm && (
          <Form
            className={styles.form}
            method="post"
            action="/auth/login"
            reloadDocument
          >
            <label className={styles.label}>
              <span>Shop domain</span>
              <input
                className={styles.input}
                type="text"
                name="shop"
                placeholder="my-store.myshopify.com"
                autoComplete="url"
                required
              />
              <span>
                Use your permanent .myshopify.com domain, not your public
                storefront URL.
              </span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Validate before creating</strong>. Catch malformed orders
            and missing catalog mappings before they reach Shopify.
          </li>
          <li>
            <strong>Import asynchronously</strong>. Upload CSV orders without
            waiting for every Shopify operation to finish in the browser.
          </li>
          <li>
            <strong>Recover safely</strong>. Track failures and reconcile
            uncertain results without blindly creating duplicate orders.
          </li>
        </ul>
      </div>
    </div>
  );
}
