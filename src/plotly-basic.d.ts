declare module 'plotly.js-basic-dist-min' {
  const Plotly: {
    newPlot: (element: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>) => Promise<HTMLElement>;
    react: (element: HTMLElement, data: unknown[], layout: Record<string, unknown>, config: Record<string, unknown>) => Promise<HTMLElement>;
    relayout: (element: HTMLElement, update: Record<string, unknown>) => Promise<HTMLElement>;
    purge: (element: HTMLElement) => void;
  };
  export default Plotly;
}
