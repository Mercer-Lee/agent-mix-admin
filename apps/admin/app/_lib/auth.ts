import { cookies } from "next/headers";
import { cache } from "react";

export interface AuthContext {
  user: {
    id: string;
    username: string;
    displayName: string;
    email: string | null;
    department: { id: string; code: string; name: string } | null;
  };
  roles: Array<{ id: string; key: string; name: string }>;
  permissions: string[];
}

export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const cookieStore = await cookies();
  const response = await fetch(`${process.env.SERVER_INTERNAL_URL ?? "http://localhost:3101"}/api/auth/me`, {
    headers: { cookie: cookieStore.toString() },
    cache: "no-store",
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error(`Authentication service returned ${response.status}`);
  return (await response.json()) as AuthContext;
});
