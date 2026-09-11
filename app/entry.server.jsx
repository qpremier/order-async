import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import {
  createProcessLogger,
  getRequestCorrelationId,
  sanitizeErrorMessage,
} from "./services/logging/logger.server";

export const streamTimeout = 5000;

const logger = createProcessLogger("web");

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  const startedAt = Date.now();
  const correlationId = getRequestCorrelationId(request);
  const requestUrl = new URL(request.url);
  const requestLogger = logger.child({
    correlationId,
    requestMethod: request.method,
    requestPath: requestUrl.pathname,
  });

  addDocumentResponseHeaders(request, responseHeaders);
  responseHeaders.set("X-Correlation-ID", correlationId);
  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={reactRouterContext} url={request.url} />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            }),
          );
          requestLogger.info("server.request.rendered", {
            operationName: "server.render",
            statusCode: responseStatusCode,
            durationMs: Date.now() - startedAt,
          });
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          requestLogger.error("server.request.render_failed", {
            operationName: "server.render",
            statusCode: responseStatusCode,
            durationMs: Date.now() - startedAt,
            error: sanitizeErrorMessage(error),
          });
        },
      },
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}
