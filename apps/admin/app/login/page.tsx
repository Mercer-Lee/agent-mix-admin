import { redirect } from "next/navigation";
import { getAuthContext } from "../_lib/auth";
import { LoginForm } from "./login-form";
import styles from "./login.module.css";

export default async function LoginPage() {
  const auth = await getAuthContext();
  if (auth) redirect("/");

  return (
    <main className={styles.shell}>
      <div className={styles.grid} aria-hidden="true" />
      <section className={styles.statement}>
        <p className={styles.eyebrow}>AgentMix / Enterprise Control Plane</p>
        <h1>
          权限先行，
          <br />
          Agent 才能真正进入企业。
        </h1>
        <p className={styles.copy}>身份、角色、工具调用与成本，最终都应回到可验证的治理边界。</p>
        <div className={styles.signal}>
          <span /> CONTROL PLANE ONLINE
        </div>
      </section>
      <section className={styles.panel} aria-label="AgentMix 登录">
        <div className={styles.panelHeader}>
          <span>AUTH / 01</span>
          <span>SESSION: 12H</span>
        </div>
        <div className={styles.panelBody}>
          <div className={styles.mark}>AM</div>
          <h2>进入管理控制台</h2>
          <p>使用管理员分配给你的内部账号。</p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
