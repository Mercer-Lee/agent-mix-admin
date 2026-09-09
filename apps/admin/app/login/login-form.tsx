"use client";

import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { Alert, Button, Form, Input } from "antd";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

interface LoginFields {
  username: string;
  password: string;
}

export function LoginForm() {
  const t = useTranslations("login");
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
          response.status === 429 ? t("rateLimited") : t("invalidCredentials"),
        );
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError(t("serviceUnavailable"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Form<LoginFields> layout="vertical" requiredMark={false} onFinish={submit}>
      {error ? <Alert data-testid="login-error" className="mb-5" type="error" showIcon title={error} /> : null}
      <Form.Item
        name="username"
        label={t("usernameLabel")}
        rules={[{ required: true, message: t("usernameRequired") }]}
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
        label={t("passwordLabel")}
        rules={[
          { required: true, message: t("passwordRequired") },
          { min: 12, message: t("passwordMin") },
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
        {t("submit")}
      </Button>
    </Form>
  );
}
