"use client";

import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input } from "antd";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface LoginFields {
  username: string;
  password: string;
}

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(values: LoginFields) {
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!response.ok) {
        setError(
          response.status === 429
            ? "Too many sign-in attempts. Try again later."
            : "The username or password is incorrect.",
        );
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("The authentication service is temporarily unavailable.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Form<LoginFields> layout="vertical" requiredMark={false} onFinish={submit}>
      {error ? <Alert data-testid="login-error" className="mb-5" type="error" showIcon title={error} /> : null}
      <Form.Item
        name="username"
        label="Username"
        rules={[{ required: true, message: "Enter your username" }]}
      >
        <Input
          data-testid="login-username"
          autoComplete="username"
          prefix={<UserOutlined />}
          placeholder="admin"
          size="large"
        />
      </Form.Item>
      <Form.Item
        name="password"
        label="Password"
        rules={[
          { required: true, message: "Enter your password" },
          { min: 12, message: "Password must contain at least 12 characters" },
        ]}
      >
        <Input.Password
          data-testid="login-password"
          autoComplete="current-password"
          prefix={<LockOutlined />}
          placeholder="••••••••••••"
          size="large"
        />
      </Form.Item>
      <Button
        data-testid="login-submit"
        className="mt-2 w-full"
        type="primary"
        htmlType="submit"
        size="large"
        loading={submitting}
      >
        Verify identity and enter
      </Button>
    </Form>
  );
}
