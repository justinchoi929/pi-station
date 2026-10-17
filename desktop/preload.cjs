// Tells the page it runs in the macOS desktop window, whose hidden title bar puts the
// traffic lights over the top bars (see the data-desktop rules in app/globals.css).
// The preload runs before the document has a root, and React may drop attributes it
// did not render on <html>, so the mark goes on once the root exists and comes back.
if (process.platform === "darwin") {
  const mark = () => {
    const root = document.documentElement;
    if (root.dataset.desktop !== "mac") root.dataset.desktop = "mac";
  };
  window.addEventListener("DOMContentLoaded", () => {
    mark();
    new MutationObserver(mark).observe(document.documentElement, { attributes: true, attributeFilter: ["data-desktop"] });
  });
}
