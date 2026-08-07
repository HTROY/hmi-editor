const KEY = "hmi_io_operator";

export function getOperator(): string {
  return localStorage.getItem(KEY) || "operator";
}

export function setOperator(name: string): void {
  localStorage.setItem(KEY, name.trim() || "operator");
}
