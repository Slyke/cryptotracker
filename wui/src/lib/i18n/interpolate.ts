export const interpolate = ({
  template,
  values
}: {
  template: string;
  values: Record<string, string | number>;
}) => template.replace(/\{\$([A-Za-z0-9_]+)\}/g, (_match, key: string) => String(values[key] ?? ''));
