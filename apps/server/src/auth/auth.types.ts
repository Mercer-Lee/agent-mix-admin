import type { Request } from "express";

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

export interface SessionIdentity {
  sessionId: string;
  subjectId: string;
  context: AuthContext;
}

export interface AuthenticatedRequest extends Request {
  auth: SessionIdentity;
}
