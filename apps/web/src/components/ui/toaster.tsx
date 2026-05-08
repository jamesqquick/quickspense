import { useEffect } from "react";
import { Toaster as SonnerToaster, toast } from "sonner";

type ToastType = "success" | "error" | "info";

declare global {
  interface Window {
    qsToast?: (type: ToastType, message: string) => void;
  }
}

const FLASH_PARAM = "toast";
const FLASH_MSG_PARAM = "toast_msg";

function consumeFlashToast() {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const type = url.searchParams.get(FLASH_PARAM) as ToastType | null;
  const message = url.searchParams.get(FLASH_MSG_PARAM);
  if (!type || !message) return;

  if (type === "success" || type === "error" || type === "info") {
    toast[type](message);
  }

  url.searchParams.delete(FLASH_PARAM);
  url.searchParams.delete(FLASH_MSG_PARAM);
  window.history.replaceState({}, "", url.toString());
}

export function Toaster() {
  useEffect(() => {
    window.qsToast = (type, message) => {
      if (type === "success" || type === "error" || type === "info") {
        toast[type](message);
      }
    };
    consumeFlashToast();
    return () => {
      if (window.qsToast) delete window.qsToast;
    };
  }, []);

  return (
    <SonnerToaster
      theme="dark"
      position="top-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "!rounded-xl !border !border-white/10 !bg-surface-800/95 !backdrop-blur",
        },
      }}
    />
  );
}
