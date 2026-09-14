import { loadEnv } from "vite";

const environment = loadEnv(
  process.env.NODE_ENV || "development",
  process.cwd(),
  "",
);
const appHost = environment.SHOPIFY_APP_URL
  ? new URL(environment.SHOPIFY_APP_URL).host
  : undefined;

/** @type {import('@react-router/dev/config').Config} */
export default {
  // The tunnel terminates TLS before forwarding to the local Vite server.
  // Allow only the public host configured for this app to submit actions.
  allowedActionOrigins: appHost ? [appHost] : [],
};
