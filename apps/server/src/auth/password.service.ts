import { Injectable } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";

const ARGON2_OPTIONS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

@Injectable()
export class PasswordService {
  private readonly dummyHash = hash("agentmix-nonexistent-user-password", ARGON2_OPTIONS);

  hash(password: string): Promise<string> {
    return hash(password, ARGON2_OPTIONS);
  }

  verify(passwordHash: string, password: string): Promise<boolean> {
    return verify(passwordHash, password);
  }

  async verifyOrDummy(passwordHash: string | null, password: string): Promise<boolean> {
    return verify(passwordHash ?? (await this.dummyHash), password);
  }
}
