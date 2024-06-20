export const waitForTimeout = (milliseconds) =>
  new Promise((r) => setTimeout(r, milliseconds));
