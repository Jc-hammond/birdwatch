// Restore the override before the dashboard or its stylesheet can paint.
try {
  const theme = localStorage.getItem("birdwatch.theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {
  // CSS follows the system setting when storage is unavailable.
}
