(function () {
  try {
    var preference = localStorage.getItem("agent1-theme") || "system";
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var resolved = preference === "system" ? (dark ? "dark" : "light") : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.colorScheme = resolved;
    document.documentElement.style.colorScheme = resolved;
  } catch (error) {
    document.documentElement.dataset.theme = "dark";
    document.documentElement.dataset.colorScheme = "dark";
  }
})();
