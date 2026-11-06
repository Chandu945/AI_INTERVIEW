// The browser tests (npm test) set INTERACT_TESTS=1. They then build into their own folder, so
// they never disturb your dev server or build, and hide the Next.js dev badge so screenshots
// only show the app.
const testing = process.env.INTERACT_TESTS === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: testing ? '.next-test' : '.next',
  ...(testing && { devIndicators: false }),
};

export default nextConfig;
