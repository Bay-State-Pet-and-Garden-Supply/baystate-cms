export interface Result<T> {
  success: boolean;
  data?: T;
  error?: string;
  errors: string[];
}

export function ok<T>(data: T): Result<T> {
  return { success: true, data, errors: [] };
}

export function fail<T>(error: string, ...errors: string[]): Result<T> {
  return { success: false, error, errors: errors.length > 0 ? errors : [error] };
}

export function failWithErrors<T>(errors: string[]): Result<T> {
  return { success: false, error: errors[0], errors };
}
