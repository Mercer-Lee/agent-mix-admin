import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { getAuthContext } from "../_lib/auth";
import { LocaleSwitcher } from "../(protected)/_components/locale-switcher";
import { LoginForm } from "./login-form";
import styles from "./login.module.css";

export default async function LoginPage() {
  const auth = await getAuthContext();
  if (auth) redirect("/");

  const t = await getTranslations("login");

  return (
    <main className={styles.shell}>
      <div className="fixed right-4 top-4 z-10">
        <LocaleSwitcher />
      </div>
      <div className={styles.grid} aria-hidden="true" />
      <section className={styles.statement}>
        <p className={styles.eyebrow}>{t("eyebrow")}</p>
        <h1>
          {t("headline1")}
          <br />
          {t("headline2")}
        </h1>
        <p className={styles.copy}>{t("copy")}</p>
        <div className={styles.signal}>
          <span /> {t("signal")}
        </div>
      </section>
      <section className={styles.panel} aria-label={t("panelAria")}>
        <div className={styles.panelHeader}>
          <span>{t("authTag")}</span>
          <span>{t("sessionTag")}</span>
        </div>
        <div className={styles.panelBody}>
          <div className={styles.mark}>AM</div>
          <h2>{t("enterHeading")}</h2>
          <p>{t("enterHint")}</p>
          <LoginForm />
        </div>
      </section>
    </main>
  );
}
