/**
 * Tailwind v4 config — loaded from src/index.css via `@config`.
 * Pulls in the Decentral Park brand preset (colors + font families) per
 * @decentralpark/ui's README, on top of the CSS-first theme in
 * @decentralpark/ui/theme.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  presets: [require("@decentralpark/ui/tailwind-preset")],
};
