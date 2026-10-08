// Ambient declarations for side-effect imports of static assets.
// Next.js handles these at build time; TypeScript 6 requires explicit
// declarations rather than implicit any for unknown module specifiers.
declare module "*.css";
declare module "*.scss";
declare module "*.sass";
