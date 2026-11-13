import {
  checkAbort,
  convertSdocx,
  type ConversionOptions,
  type ConversionResult,
} from "@sdocx-importer/converter";
import type { WorkerMessage } from "./worker";

declare const CONVERTER_WORKER: string;
/** Dedicated worker per conversion; terminating it cancels even synchronous parsing. */
export async function runConversion(
  bytes: Uint8Array | ArrayBuffer,
  options: ConversionOptions = {},
): Promise<ConversionResult> {
  checkAbort(options.signal);
  if (typeof Worker === "undefined") return convertSdocx(bytes, options);
  let worker: Worker, url: string;
  try {
    url = URL.createObjectURL(
      new Blob([CONVERTER_WORKER], { type: "text/javascript" }),
    );
    try {
      worker = new Worker(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return convertSdocx(bytes, options);
  }
  let ready = false;
  try {
    return await new Promise<ConversionResult>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (!ready) finish(new Error("Worker startup unavailable"));
      }, 2000);
      const aborted = () => {
        const reason: unknown = options.signal?.reason;
        finish(
          reason instanceof Error
            ? reason
            : new DOMException(
                reason === undefined ? "Aborted" : String(reason),
                "AbortError",
              ),
        );
      };
      const cleanup = () => {
        window.clearTimeout(timer);
        options.signal?.removeEventListener("abort", aborted);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
      };
      const finish = (error: Error) => {
        cleanup();
        reject(error);
      };
      options.signal?.addEventListener("abort", aborted, { once: true });
      worker.onerror = (event) => {
        event.preventDefault();
        finish(new Error(event.message || "Conversion worker failed"));
      };
      worker.onmessageerror = () =>
        finish(new Error("Unable to receive conversion result"));
      worker.onmessage = ({ data }: MessageEvent<WorkerMessage>) => {
        try {
          if (data.type === "ready") {
            ready = true;
            window.clearTimeout(timer);
            const copy =
              bytes instanceof Uint8Array
                ? bytes.slice().buffer
                : bytes.slice(0);
            worker.postMessage(
              {
                bytes: copy,
                options: {
                  strokeScale: options.strokeScale,
                  textLineHeight: options.textLineHeight,
                  pageFrames: options.pageFrames,
                },
              },
              [copy],
            );
          } else if (data.type === "progress")
            options.onProgress?.(data.progress);
          else if (data.type === "error") finish(new Error(data.error));
          else if (data.type === "result") {
            cleanup();
            resolve(data.result);
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      };
      if (options.signal?.aborted) aborted();
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (!ready) return convertSdocx(bytes, options);
    throw error;
  } finally {
    worker.terminate();
  }
}
