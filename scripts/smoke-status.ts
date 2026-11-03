export function assertStatus(name: string, res: Response, status: number): void {
  if (res.status !== status) throw new Error(`${name}: expected ${status}, got ${res.status}`);
  console.log(`PASS ${name} -> ${status}`);
}
