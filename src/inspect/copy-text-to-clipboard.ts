/**
 * One place that puts text on the clipboard, and reports in words what it put
 * there or exactly why it could not.
 *
 * navigator.clipboard needs a secure context; http://127.0.0.1 counts as one,
 * so the async path is the normal path. The textarea fallback exists for a
 * browser that denies the permission outright.
 */
export async function copyTextToClipboard(
  text: string,
): Promise<{ copied: true } | { copied: false; error: string }> {
  try {
    await navigator.clipboard.writeText(text);
    return { copied: true };
  } catch (clipboardApiError) {
    try {
      const carrier = document.createElement("textarea");
      carrier.value = text;
      carrier.setAttribute("readonly", "");
      carrier.style.position = "fixed";
      carrier.style.opacity = "0";
      document.body.appendChild(carrier);
      carrier.select();
      const copiedByExecCommand = document.execCommand("copy");
      carrier.remove();
      if (copiedByExecCommand) return { copied: true };
      return {
        copied: false,
        error: `navigator.clipboard.writeText failed with ${String(clipboardApiError)} and document.execCommand("copy") returned false`,
      };
    } catch (fallbackError) {
      return {
        copied: false,
        error: `navigator.clipboard.writeText failed with ${String(clipboardApiError)}; the textarea fallback failed with ${String(fallbackError)}`,
      };
    }
  }
}
