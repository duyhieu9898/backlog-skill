export function formatDate(date = new Date()): string {
  return date.toLocaleString("sv-SE", {
    timeZone: process.env.TZ || "Asia/Ho_Chi_Minh",
    hour12: false,
    timeZoneName: "short",
  });
}

export function tailLines(text: string, maxLines: number): string {
  return text.trim().split(/\r?\n/).slice(-maxLines).join("\n") || "(không có output)";
}
