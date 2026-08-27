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
          Governance first.
          <br />
          Agents ready for enterprise.
        </h1>
        <p className={styles.copy}>
          Identity, roles, tool access, and cost all return to one verifiable governance boundary.
        </p>
        <div className={styles.signal}>
          <span /> CONTROL PLANE ONLINE
        </div>
      </section>
      <section className={styles.panel} aria-label="AgentMix sign in">
        <div className={styles.panelHeader}>
          <span>AUTH / 01</span>
          <span>SESSION: 12H</span>
        </div>
        <div className={styles.panelBody}>
          <div className={styles.mark}>AM</div>
          <h2>Enter the admin console</h2>
          <p>Use the internal account assigned by your administrator.</p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
