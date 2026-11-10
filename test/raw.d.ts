// Vite's ?raw imports (a source file as a string), for tests that pin code shape.
declare module '*?raw' {
  const source: string;
  export default source;
}
