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
        setError(response.status === 429 ? "登录尝试过于频繁，请稍后再试。" : "用户名或密码不正确。请输入后重试。");
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("认证服务暂时不可用，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Form<LoginFields> layout="vertical" requiredMark={false} onFinish={submit}>
      {error ? <Alert className="mb-5" type="error" showIcon title={error} /> : null}
      <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
        <Input autoComplete="username" prefix={<UserOutlined />} placeholder="admin" size="large" />
      </Form.Item>
      <Form.Item
        name="password"
        label="密码"
        rules={[
          { required: true, message: "请输入密码" },
          { min: 12, message: "密码至少需要 12 个字符" },
        ]}
      >
        <Input.Password
          autoComplete="current-password"
          prefix={<LockOutlined />}
          placeholder="••••••••••••"
          size="large"
        />
      </Form.Item>
      <Button className="mt-2 w-full" type="primary" htmlType="submit" size="large" loading={submitting}>
        验证身份并进入
      </Button>
    </Form>
  );
}
