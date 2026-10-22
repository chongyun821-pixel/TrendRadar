export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, { ...options, headers: options.body instanceof FormData ? options.headers : { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || '요청을 처리하지 못했습니다.', response.status);
  return data;
}
export const post = <T = any>(path: string, data: any = {}) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
export const patch = <T = any>(path: string, data: any) => api<T>(path, { method: 'PATCH', body: JSON.stringify(data) });
