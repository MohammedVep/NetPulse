export function csvEscape(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  if (!text.includes(",") && !text.includes("\n") && !text.includes('"')) {
    return text;
  }

  return `"${text.replaceAll('"', '""')}"`;
}

export function csvLine(values: Array<string | number | boolean | undefined>): string {
  return `${values.map(csvEscape).join(",")}\n`;
}
