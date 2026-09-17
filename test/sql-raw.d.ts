// Vite inlines `?raw` imports as strings; the tests replay the real migration
// file rather than keeping a second copy of the schema.
declare module "*.sql?raw" {
  const content: string;
  export default content;
}
