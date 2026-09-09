"use client";

import {
  ApiOutlined,
  AppstoreOutlined,
  DeleteOutlined,
  EditOutlined,
  LockOutlined,
  PlusOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  type TableProps,
} from "antd";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import {
  createAgentAction,
  updateAgentAccessAction,
  updateAgentPermissionsAction,
  updateAgentProfileAction,
  updateAgentRolesAction,
  updateAgentRuntimeAction,
} from "./actions";
import type {
  AgentDetail,
  AgentInvocationAccess,
  AgentListResponse,
  AgentManagerAccess,
  AgentProfileMutationInput,
  AgentRuntime,
  AgentSummary,
  CapabilityDescriptor,
  DepartmentOption,
  ModelProfileOption,
  PermissionOption,
  RoleOption,
  UserOption,
  UserListResponse,
} from "./types";

interface AgentsManagerProps {
  initialData: AgentListResponse;
  roles: RoleOption[];
  permissions: PermissionOption[];
  users: UserOption[];
  userTotal: number;
  departments: DepartmentOption[];
  modelProfiles: ModelProfileOption[];
  query: { search: string; status: string };
  access: AgentManagerAccess;
}

interface ProfileFormValues extends AgentProfileMutationInput {
  slug: string;
  status: "active" | "disabled";
}

interface RuntimeFormValues {
  modelProfileId: string;
  systemPrompt: string;
  maxOutputTokens: number;
}

interface AccessFormValues {
  userIds: string[];
  roleIds: string[];
  departments: Array<{ departmentId: string; includeDescendants: boolean }>;
}

class ApiRequestError extends Error {
  constructor(readonly status: number) {
    super(`Request failed with status ${status}`);
  }
}

async function readJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new ApiRequestError(response.status);
  return (await response.json()) as T;
}

function SectionHeading({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="mb-5 border-b border-white/10 pb-4">
      <div className="flex items-center gap-2 text-zinc-100">
        <span className="text-[#b8f500]">{icon}</span>
        <h3 className="m-0 text-base font-medium">{title}</h3>
      </div>
      <p className="mb-0 mt-2 text-sm leading-6 text-zinc-500">{detail}</p>
    </div>
  );
}

export function AgentsManager({
  initialData,
  roles,
  permissions,
  users,
  userTotal,
  departments,
  modelProfiles,
  query,
  access,
}: AgentsManagerProps) {
  const router = useRouter();
  const t = useTranslations("agents");
  const locale = useLocale();
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }),
    [locale],
  );
  const [profileForm] = Form.useForm<ProfileFormValues>();
  const [roleForm] = Form.useForm<{ roleIds: string[] }>();
  const [permissionForm] = Form.useForm<{ permissionIds: string[] }>();
  const [runtimeForm] = Form.useForm<RuntimeFormValues>();
  const [invocationForm] = Form.useForm<AccessFormValues>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeDetailTab, setActiveDetailTab] = useState("profile");
  const [mode, setMode] = useState<"create" | "detail">("create");
  const [selected, setSelected] = useState<AgentDetail | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>([]);
  const [runtime, setRuntime] = useState<AgentRuntime | null>(null);
  const [invocationAccess, setInvocationAccess] = useState<AgentInvocationAccess | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [savingSection, setSavingSection] = useState<string | null>(null);
  const [authorizationSurfaceUnavailable, setAuthorizationSurfaceUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [search, setSearch] = useState(query.search);
  const [status, setStatus] = useState(query.status);
  const [userCandidates, setUserCandidates] = useState(users);
  const [userDirectoryPage, setUserDirectoryPage] = useState(1);
  const [userDirectoryTotal, setUserDirectoryTotal] = useState(userTotal);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [userDirectoryError, setUserDirectoryError] = useState<string | null>(null);
  const detailGenerationRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);
  const activeAgentIdRef = useRef<string | null>(null);
  const drawerOpenRef = useRef(false);
  const userSearchRef = useRef("");
  const userSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userSearchGenerationRef = useRef(0);
  const userSearchControllerRef = useRef<AbortController | null>(null);

  const roleOptions = useMemo(() => {
    const merged = new Map(roles.map((role) => [role.id, role]));
    invocationAccess?.roles.forEach((role) => {
      if (!merged.has(role.id)) merged.set(role.id, { ...role, description: "", isSystem: false });
    });
    selected?.roles.forEach((role) => {
      if (!merged.has(role.id)) merged.set(role.id, { ...role, description: "", isSystem: false });
    });
    return [...merged.values()].map((role) => ({ label: `${role.name} / ${role.key}`, value: role.id }));
  }, [invocationAccess, roles, selected]);

  const permissionOptions = useMemo(() => {
    const merged = new Map(permissions.map((permission) => [permission.id, permission]));
    selected?.directPermissions.forEach((permission) => merged.set(permission.id, permission));
    return [...merged.values()].map((permission) => ({
      label: `${permission.key} — ${permission.description}`,
      value: permission.id,
    }));
  }, [permissions, selected]);

  const userOptions = useMemo(() => {
    const merged = new Map(userCandidates.map((user) => [user.id, user]));
    invocationAccess?.users.forEach((user) => merged.set(user.id, user));
    return [...merged.values()].map((user) => ({
      label: `${user.displayName} / @${user.username}`,
      value: user.id,
    }));
  }, [invocationAccess, userCandidates]);

  const departmentOptions = useMemo(() => {
    const merged = new Map(departments.map((department) => [department.id, department]));
    invocationAccess?.departments.forEach((department) => merged.set(department.id, department));
    return [...merged.values()].map((department) => ({
      label: `${department.name} / ${department.code}`,
      value: department.id,
    }));
  }, [departments, invocationAccess]);

  const modelOptions = useMemo(() => {
    const merged = new Map(modelProfiles.map((profile) => [profile.id, profile]));
    if (runtime?.modelProfile) merged.set(runtime.modelProfile.id, runtime.modelProfile);
    return [...merged.values()].map((profile) => ({
      label: `${profile.name} / ${profile.modelId}${profile.status === "disabled" ? ` ${t("runtime.modelDisabledSuffix")}` : ""}`,
      value: profile.id,
      disabled: profile.status === "disabled" && profile.id !== runtime?.modelProfileId,
    }));
  }, [modelProfiles, runtime]);

  const canManageAny =
    access.canUpdateProfile ||
    access.canAssignRoles ||
    access.canAssignPermissions ||
    access.canConfigureRuntime ||
    access.canAssignAccess;

  function invalidateDetailRequests() {
    detailGenerationRef.current += 1;
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
  }

  function beginDetailRequest() {
    invalidateDetailRequests();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    return { controller, generation: detailGenerationRef.current };
  }

  function isCurrentDetailRequest(generation: number, agentId: string) {
    return (
      generation === detailGenerationRef.current &&
      drawerOpenRef.current &&
      activeAgentIdRef.current === agentId
    );
  }

  function invalidateUserSearch() {
    userSearchGenerationRef.current += 1;
    userSearchControllerRef.current?.abort();
    userSearchControllerRef.current = null;
    if (userSearchTimerRef.current) {
      clearTimeout(userSearchTimerRef.current);
      userSearchTimerRef.current = null;
    }
  }

  function resetUserDirectory() {
    invalidateUserSearch();
    userSearchRef.current = "";
    setUserCandidates(users);
    setUserDirectoryPage(1);
    setUserDirectoryTotal(userTotal);
    setLoadingUsers(false);
    setUserDirectoryError(null);
  }

  function closeDrawer() {
    drawerOpenRef.current = false;
    activeAgentIdRef.current = null;
    invalidateDetailRequests();
    invalidateUserSearch();
    setLoadingDetail(false);
    setDrawerOpen(false);
  }

  useEffect(() => () => {
    detailControllerRef.current?.abort();
    userSearchControllerRef.current?.abort();
    if (userSearchTimerRef.current) clearTimeout(userSearchTimerRef.current);
  }, []);

  function navigate(nextPage = 1) {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (status) params.set("status", status);
    if (nextPage > 1) params.set("page", String(nextPage));
    router.push(params.size ? `/agents?${params}` : "/agents");
  }

  function openCreate() {
    invalidateDetailRequests();
    activeAgentIdRef.current = null;
    drawerOpenRef.current = true;
    resetUserDirectory();
    setActiveDetailTab("profile");
    setMode("create");
    setSelected(null);
    setRuntime(null);
    setInvocationAccess(null);
    setCapabilities([]);
    setAuthorizationSurfaceUnavailable(false);
    setError(null);
    setNotice(null);
    setDrawerOpen(true);
  }

  async function openDetail(agent: AgentSummary) {
    const { controller, generation } = beginDetailRequest();
    activeAgentIdRef.current = agent.id;
    drawerOpenRef.current = true;
    resetUserDirectory();
    setActiveDetailTab("profile");
    setMode("detail");
    setSelected(null);
    setRuntime(null);
    setInvocationAccess(null);
    setCapabilities([]);
    setAuthorizationSurfaceUnavailable(false);
    setError(null);
    setNotice(null);
    setDrawerOpen(true);
    setLoadingDetail(true);
    try {
      const [detail, availableCapabilities, runtimeResult, accessResult] = await Promise.all([
        readJson<AgentDetail>(`/api/agents/${agent.id}`, controller.signal),
        readJson<CapabilityDescriptor[]>(`/api/agents/${agent.id}/capabilities`, controller.signal),
        access.canConfigureRuntime
          ? readJson<AgentRuntime>(`/api/agents/${agent.id}/runtime`, controller.signal)
          : Promise.resolve(null),
        access.canAssignAccess
          ? readJson<AgentInvocationAccess>(`/api/agents/${agent.id}/access`, controller.signal)
          : Promise.resolve(null),
      ]);
      if (!isCurrentDetailRequest(generation, agent.id)) return;
      setSelected(detail);
      setCapabilities(availableCapabilities);
      setAuthorizationSurfaceUnavailable(false);
      setRuntime(runtimeResult);
      setInvocationAccess(accessResult);
    } catch (requestError) {
      if (controller.signal.aborted || !isCurrentDetailRequest(generation, agent.id)) return;
      if (requestError instanceof ApiRequestError && requestError.status === 403) {
        setError(t("errors.permissionChanged"));
      } else if (requestError instanceof ApiRequestError && requestError.status === 404) {
        setError(t("errors.notFound"));
      } else {
        setError(t("errors.loadFailed"));
      }
    } finally {
      if (isCurrentDetailRequest(generation, agent.id)) setLoadingDetail(false);
    }
  }

  async function loadUserDirectory(searchValue: string, page: number, append: boolean) {
    if (!access.canReadUsers || !drawerOpenRef.current || !activeAgentIdRef.current) return;
    userSearchControllerRef.current?.abort();
    const controller = new AbortController();
    const generation = userSearchGenerationRef.current + 1;
    userSearchGenerationRef.current = generation;
    userSearchControllerRef.current = controller;
    setLoadingUsers(true);
    setUserDirectoryError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: "20" });
    const normalizedSearch = searchValue.trim().slice(0, 80);
    if (normalizedSearch) params.set("search", normalizedSearch);
    try {
      const response = await readJson<UserListResponse>(`/api/users?${params}`, controller.signal);
      if (controller.signal.aborted || generation !== userSearchGenerationRef.current) return;
      setUserCandidates((current) => {
        const merged = new Map((append ? current : []).map((user) => [user.id, user]));
        response.items.forEach((user) => merged.set(user.id, user));
        return [...merged.values()];
      });
      setUserDirectoryPage(response.page);
      setUserDirectoryTotal(response.total);
    } catch {
      if (controller.signal.aborted || generation !== userSearchGenerationRef.current) return;
      setUserDirectoryError(t("access.userSearchUnavailable"));
    } finally {
      if (generation === userSearchGenerationRef.current) setLoadingUsers(false);
    }
  }

  function scheduleUserSearch(value: string) {
    userSearchRef.current = value;
    userSearchGenerationRef.current += 1;
    userSearchControllerRef.current?.abort();
    userSearchControllerRef.current = null;
    setLoadingUsers(true);
    if (userSearchTimerRef.current) clearTimeout(userSearchTimerRef.current);
    userSearchTimerRef.current = setTimeout(() => {
      userSearchTimerRef.current = null;
      void loadUserDirectory(value, 1, false);
    }, 250);
  }

  function loadMoreUsers(event: UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const reachedEnd = target.scrollTop + target.clientHeight >= target.scrollHeight - 24;
    if (!reachedEnd || loadingUsers || userCandidates.length >= userDirectoryTotal) return;
    void loadUserDirectory(userSearchRef.current, userDirectoryPage + 1, true);
  }

  useEffect(() => {
    if (!drawerOpen || mode !== "detail" || !selected || activeDetailTab !== "profile") return;
    profileForm.setFieldsValue({
      slug: selected.slug,
      name: selected.name,
      description: selected.description,
      status: selected.status,
    });
  }, [activeDetailTab, drawerOpen, mode, profileForm, selected]);

  useEffect(() => {
    if (!drawerOpen || mode !== "detail" || !selected || activeDetailTab !== "capabilities") return;
    roleForm.setFieldsValue({ roleIds: selected.roles.map((role) => role.id) });
    permissionForm.setFieldsValue({
      permissionIds: selected.directPermissions.map((permission) => permission.id),
    });
  }, [activeDetailTab, drawerOpen, mode, permissionForm, roleForm, selected]);

  useEffect(() => {
    if (
      !drawerOpen ||
      mode !== "detail" ||
      !selected ||
      activeDetailTab !== "runtime" ||
      !access.canConfigureRuntime
    ) return;
    runtimeForm.setFieldsValue({
      modelProfileId: runtime?.modelProfileId ?? "",
      systemPrompt: runtime?.systemPrompt ?? "",
      maxOutputTokens: runtime?.maxOutputTokens ?? 2048,
    });
  }, [access.canConfigureRuntime, activeDetailTab, drawerOpen, mode, runtime, runtimeForm, selected]);

  useEffect(() => {
    if (
      !drawerOpen ||
      mode !== "detail" ||
      !selected ||
      activeDetailTab !== "access" ||
      !access.canAssignAccess
    ) return;
    invocationForm.setFieldsValue({
      userIds: invocationAccess?.users.map((user) => user.id) ?? [],
      roleIds: invocationAccess?.roles.map((role) => role.id) ?? [],
      departments:
        invocationAccess?.departments.map((department) => ({
          departmentId: department.id,
          includeDescendants: department.includeDescendants,
        })) ?? [],
    });
  }, [access.canAssignAccess, activeDetailTab, drawerOpen, invocationAccess, invocationForm, mode, selected]);

  async function submitCreate(values: ProfileFormValues) {
    setSavingSection("create");
    setError(null);
    const result = await createAgentAction({
      slug: values.slug,
      name: values.name,
      description: values.description ?? "",
    });
    setSavingSection(null);
    if (!result.ok) {
      setError(result.error ?? t("errors.createFailed"));
      return;
    }
    closeDrawer();
    router.refresh();
  }

  async function saveProfile() {
    if (!selected) return;
    const values = await profileForm.validateFields();
    setSavingSection("profile");
    setError(null);
    setNotice(null);
    const result = await updateAgentProfileAction(selected.id, values);
    setSavingSection(null);
    if (!result.ok || !result.data) {
      setError(result.error ?? t("errors.profileFailed"));
      return;
    }
    setSelected(result.data);
    setNotice(t("notices.profileSaved"));
    router.refresh();
  }

  async function saveRoles() {
    if (!selected) return;
    const values = await roleForm.validateFields();
    setSavingSection("roles");
    setError(null);
    setNotice(null);
    const result = await updateAgentRolesAction(selected.id, values.roleIds ?? []);
    if (!result.ok) {
      setSavingSection(null);
      setError(result.error ?? t("errors.rolesFailed"));
      return;
    }
    const refreshed = await refreshAuthorizationSurface(selected.id);
    setSavingSection(null);
    if (refreshed === null) return;
    if (!refreshed) {
      setError(t("errors.rolesSurfaceFailed"));
      return;
    }
    setNotice(t("notices.rolesSaved"));
    router.refresh();
  }

  async function savePermissions() {
    if (!selected) return;
    const values = await permissionForm.validateFields();
    setSavingSection("permissions");
    setError(null);
    setNotice(null);
    const result = await updateAgentPermissionsAction(selected.id, values.permissionIds ?? []);
    if (!result.ok) {
      setSavingSection(null);
      setError(result.error ?? t("errors.permissionsFailed"));
      return;
    }
    const refreshed = await refreshAuthorizationSurface(selected.id);
    setSavingSection(null);
    if (refreshed === null) return;
    if (!refreshed) {
      setError(t("errors.permissionsSurfaceFailed"));
      return;
    }
    setNotice(t("notices.permissionsSaved"));
    router.refresh();
  }

  async function refreshAuthorizationSurface(agentId: string): Promise<boolean | null> {
    if (!drawerOpenRef.current || activeAgentIdRef.current !== agentId) return null;
    const { controller, generation } = beginDetailRequest();
    try {
      const [detail, availableCapabilities] = await Promise.all([
        readJson<AgentDetail>(`/api/agents/${agentId}`, controller.signal),
        readJson<CapabilityDescriptor[]>(`/api/agents/${agentId}/capabilities`, controller.signal),
      ]);
      if (!isCurrentDetailRequest(generation, agentId)) return null;
      setSelected(detail);
      setCapabilities(availableCapabilities);
      setAuthorizationSurfaceUnavailable(false);
      return true;
    } catch {
      if (controller.signal.aborted || !isCurrentDetailRequest(generation, agentId)) return null;
      setCapabilities([]);
      setAuthorizationSurfaceUnavailable(true);
      return false;
    }
  }

  async function saveRuntime() {
    if (!selected) return;
    const values = await runtimeForm.validateFields();
    setSavingSection("runtime");
    setError(null);
    setNotice(null);
    const result = await updateAgentRuntimeAction(selected.id, values);
    setSavingSection(null);
    if (!result.ok || !result.data) {
      setError(result.error ?? t("errors.runtimeFailed"));
      return;
    }
    setRuntime(result.data);
    setNotice(t("notices.runtimeSaved"));
    router.refresh();
  }

  async function saveInvocationAccess() {
    if (!selected) return;
    const values = await invocationForm.validateFields();
    setSavingSection("access");
    setError(null);
    setNotice(null);
    const result = await updateAgentAccessAction(selected.id, {
      userIds: values.userIds ?? [],
      roleIds: values.roleIds ?? [],
      departments: (values.departments ?? []).map((department) => ({
        departmentId: department.departmentId,
        includeDescendants: Boolean(department.includeDescendants),
      })),
    });
    setSavingSection(null);
    if (!result.ok || !result.data) {
      setError(result.error ?? t("errors.accessFailed"));
      return;
    }
    setInvocationAccess(result.data);
    setNotice(t("notices.accessSaved"));
    router.refresh();
  }

  const columns: TableProps<AgentSummary>["columns"] = [
    {
      title: t("table.agent"),
      key: "agent",
      render: (_, agent) => (
        <div className="min-w-48">
          <button
            type="button"
            className="cursor-pointer border-0 bg-transparent p-0 text-left text-sm font-semibold text-zinc-100 hover:text-[#caff24]"
            onClick={() => void openDetail(agent)}
          >
            {agent.name}
          </button>
          <div className="mt-1 flex items-center gap-2 font-mono text-xs text-zinc-600">
            {agent.slug}
            {agent.isSystem ? <Tag color="geekblue">SYSTEM</Tag> : null}
          </div>
        </div>
      ),
    },
    {
      title: t("table.status"),
      dataIndex: "status",
      width: 110,
      render: (value: AgentSummary["status"]) =>
        value === "active" ? <Tag color="lime">{t("status.active")}</Tag> : <Tag>{t("status.disabled")}</Tag>,
    },
    {
      title: t("table.description"),
      dataIndex: "description",
      ellipsis: true,
      render: (value: string) => <span className="text-zinc-400">{value || "—"}</span>,
    },
    {
      title: t("table.updated"),
      dataIndex: "updatedAt",
      width: 170,
      render: (value: string) => (
        <span className="font-mono text-xs text-zinc-500">{dateFormatter.format(new Date(value))}</span>
      ),
    },
    {
      title: "",
      key: "action",
      width: 100,
      render: (_, agent) => (
        <Button
          data-testid={`agent-action-${agent.id}`}
          type="text"
          icon={canManageAny ? <EditOutlined /> : <ApiOutlined />}
          onClick={() => void openDetail(agent)}
        >
          {canManageAny ? t("table.manage") : t("table.view")}
        </Button>
      ),
    },
  ];

  const detailTabs = selected
    ? [
        {
          key: "profile",
          forceRender: true,
          label: (
            <span data-testid="agent-tab-profile">
              <UserOutlined /> {t("tabs.profile")}
            </span>
          ),
          children: (
            <div className="pt-4">
              <SectionHeading
                icon={<UserOutlined />}
                title={t("profile.heading")}
                detail={t("profile.headingDetail")}
              />
              <Descriptions className="mb-6" size="small" column={2} bordered>
                <Descriptions.Item label={t("profile.subjectId")} span={2}>
                  <Typography.Text copyable className="font-mono text-xs">
                    {selected.id}
                  </Typography.Text>
                </Descriptions.Item>
                <Descriptions.Item label={t("profile.systemResource")}>{selected.isSystem ? t("status.yes") : t("status.no")}</Descriptions.Item>
                <Descriptions.Item label={t("profile.created")}>
                  {dateFormatter.format(new Date(selected.createdAt))}
                </Descriptions.Item>
              </Descriptions>
              <Form<ProfileFormValues> form={profileForm} layout="vertical" requiredMark={false} clearOnDestroy>
                <Form.Item name="slug" label={t("form.slug")}>
                  <Input disabled />
                </Form.Item>
                <Form.Item name="name" label={t("form.name")} rules={[{ required: true }, { max: 120 }]}>
                  <Input disabled={!access.canUpdateProfile} />
                </Form.Item>
                <Form.Item name="description" label={t("form.description")} rules={[{ max: 2000 }]}>
                  <Input.TextArea rows={4} disabled={!access.canUpdateProfile} />
                </Form.Item>
                <Form.Item name="status" label={t("form.lifecycleStatus")} rules={[{ required: true }]}>
                  <Select
                    disabled={!access.canUpdateProfile}
                    options={[
                      { label: t("status.active"), value: "active" },
                      { label: t("status.disabled"), value: "disabled" },
                    ]}
                  />
                </Form.Item>
                {access.canUpdateProfile ? (
                  <div className="flex justify-end">
                    <Button
                      data-testid="save-agent-profile"
                      type="primary"
                      loading={savingSection === "profile"}
                      onClick={() => void saveProfile()}
                    >
                      {t("profile.save")}
                    </Button>
                  </div>
                ) : null}
              </Form>
            </div>
          ),
        },
        {
          key: "capabilities",
          forceRender: true,
          label: (
            <span data-testid="agent-tab-capabilities">
              <AppstoreOutlined /> {t("tabs.capabilities")}
            </span>
          ),
          children: (
            <div className="pt-4">
              <SectionHeading
                icon={<SafetyCertificateOutlined />}
                title={t("capabilities.heading")}
                detail={t("capabilities.headingDetail")}
              />
              <Alert
                className="mb-6"
                type="info"
                showIcon
                title={t("capabilities.boundaryTitle")}
                description={t("capabilities.boundaryDetail")}
              />
              <Form form={roleForm} layout="vertical" clearOnDestroy>
                <Form.Item name="roleIds" label={t("capabilities.inheritedRoles")}>
                  <Select
                    mode="multiple"
                    disabled={!access.canAssignRoles}
                    options={roleOptions}
                    optionFilterProp="label"
                    placeholder={t("capabilities.inheritedRolesPlaceholder")}
                  />
                </Form.Item>
                {access.canAssignRoles ? (
                  <div className="mb-7 flex justify-end">
                    <Button
                      data-testid="save-agent-roles"
                      loading={savingSection === "roles"}
                      onClick={() => void saveRoles()}
                    >
                      {t("capabilities.saveInheritedRoles")}
                    </Button>
                  </div>
                ) : null}
              </Form>
              <Form form={permissionForm} layout="vertical" clearOnDestroy>
                <Form.Item name="permissionIds" label={t("capabilities.directPermissions")}>
                  <Select
                    mode="multiple"
                    disabled={!access.canAssignPermissions}
                    options={permissionOptions}
                    optionFilterProp="label"
                    placeholder={t("capabilities.directPermissionsPlaceholder")}
                  />
                </Form.Item>
                {access.canAssignPermissions ? (
                  <div className="mb-7 flex justify-end">
                    <Button
                      data-testid="save-agent-permissions"
                      loading={savingSection === "permissions"}
                      onClick={() => void savePermissions()}
                    >
                      {t("capabilities.saveDirectPermissions")}
                    </Button>
                  </div>
                ) : null}
              </Form>
              {authorizationSurfaceUnavailable ? (
                <Alert
                  type="warning"
                  showIcon
                  title={t("capabilities.surfaceUnavailableTitle")}
                  description={t("capabilities.surfaceUnavailableDetail")}
                />
              ) : (
                <section className="border border-white/10 bg-black/20 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="font-medium">{t("capabilities.effectiveSurface")}</span>
                    <span className="font-mono text-xs text-zinc-600">
                      {t("capabilities.effectiveCount", { count: selected.effectivePermissions.length })}
                    </span>
                  </div>
                  {capabilities.length ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      {capabilities.map((capability) => (
                        <div key={capability.id} className="border border-[#b8f500]/20 bg-[#b8f500]/5 p-3">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-xs text-[#caff24]">
                              {capability.id}@{capability.version}
                            </span>
                            <Tag>{capability.risk}</Tag>
                          </div>
                          <p className="mb-0 mt-2 text-xs leading-5 text-zinc-500">{capability.description}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="m-0 text-sm text-zinc-600">{t("capabilities.noCapabilities")}</p>
                  )}
                </section>
              )}
            </div>
          ),
        },
        ...(access.canConfigureRuntime ? [{
          key: "runtime",
          forceRender: true,
          label: (
            <span data-testid="agent-tab-runtime">
              <SettingOutlined /> {t("tabs.runtime")}
            </span>
          ),
          children: (
            <div className="pt-4">
              <SectionHeading
                icon={<RobotOutlined />}
                title={t("runtime.heading")}
                detail={t("runtime.headingDetail")}
              />
              {!runtime?.configured ? (
                <Alert
                  className="mb-5"
                  type="warning"
                  showIcon
                  title={t("runtime.notConfiguredTitle")}
                  description={t("runtime.notConfiguredDetail")}
                />
              ) : null}
              <Form<RuntimeFormValues> form={runtimeForm} layout="vertical" requiredMark={false} clearOnDestroy>
                <Form.Item
                  name="modelProfileId"
                  label={t("runtime.modelProfile")}
                  rules={[{ required: true, message: t("runtime.modelProfileRequired") }]}
                >
                  <Select
                    data-testid="agent-runtime-model"
                    disabled={!access.canConfigureRuntime}
                    options={modelOptions}
                    optionFilterProp="label"
                    placeholder={t("runtime.modelProfilePlaceholder")}
                  />
                </Form.Item>
                <Form.Item
                  name="systemPrompt"
                  label={t("runtime.systemPrompt")}
                  rules={[{ required: true }, { max: 20_000 }]}
                >
                  <Input.TextArea
                    data-testid="agent-system-prompt"
                    rows={10}
                    disabled={!access.canConfigureRuntime}
                    placeholder={t("runtime.systemPromptPlaceholder")}
                  />
                </Form.Item>
                <Form.Item
                  name="maxOutputTokens"
                  label={t("runtime.maxOutputTokens")}
                  rules={[{ required: true, type: "number", min: 1, max: 32_768 }]}
                >
                  <InputNumber className="w-full" disabled={!access.canConfigureRuntime} min={1} max={32_768} />
                </Form.Item>
                <p className="font-mono text-xs leading-5 text-zinc-600">
                  {t("runtime.envNote")}
                </p>
                {access.canConfigureRuntime ? (
                  <div className="flex justify-end">
                    <Button
                      data-testid="save-agent-runtime"
                      type="primary"
                      loading={savingSection === "runtime"}
                      onClick={() => void saveRuntime()}
                    >
                      {t("runtime.save")}
                    </Button>
                  </div>
                ) : null}
              </Form>
            </div>
          ),
        }] : []),
        ...(access.canAssignAccess ? [{
          key: "access",
          forceRender: true,
          label: (
            <span data-testid="agent-tab-access">
              <TeamOutlined /> {t("tabs.access")}
            </span>
          ),
          children: (
            <div className="pt-4">
              <SectionHeading
                icon={<TeamOutlined />}
                title={t("access.heading")}
                detail={t("access.headingDetail")}
              />
              <Alert
                className="mb-6"
                type="warning"
                showIcon
                icon={<LockOutlined />}
                title={t("access.noGrantsTitle")}
                description={t("access.noGrantsDetail")}
              />
              {!access.canReadUsers ? (
                <Alert
                  className="mb-5"
                  type="info"
                  showIcon
                  title={t("access.userDirRequiredTitle")}
                  description={t("access.userDirRequiredDetail")}
                />
              ) : null}
              {!access.canReadRoles ? (
                <Alert
                  className="mb-5"
                  type="info"
                  showIcon
                  title={t("access.roleDirRequiredTitle")}
                  description={t("access.roleDirRequiredDetail")}
                />
              ) : null}
              {!access.canReadDepartments ? (
                <Alert
                  className="mb-5"
                  type="info"
                  showIcon
                  title={t("access.departmentDirRequiredTitle")}
                  description={t("access.departmentDirRequiredDetail")}
                />
              ) : null}
              {userDirectoryError ? (
                <Alert className="mb-5" type="warning" showIcon title={userDirectoryError} />
              ) : null}
              <Form<AccessFormValues> form={invocationForm} layout="vertical" requiredMark={false} clearOnDestroy>
                <Form.Item name="userIds" label={t("access.users")}>
                  <Select
                    aria-label={t("access.userCandidatesAria")}
                    data-testid="agent-user-grants"
                    mode="multiple"
                    showSearch
                    disabled={!access.canReadUsers}
                    loading={loadingUsers}
                    options={userOptions}
                    filterOption={false}
                    onSearch={scheduleUserSearch}
                    onPopupScroll={loadMoreUsers}
                    placeholder={access.canReadUsers ? t("access.userSearchPlaceholder") : t("access.userDirectoryRequiredPlaceholder")}
                  />
                </Form.Item>
                <Form.Item name="roleIds" label={t("access.roles")}>
                  <Select
                    aria-label={t("access.roleCandidatesAria")}
                    mode="multiple"
                    disabled={!access.canReadRoles}
                    options={roleOptions}
                    optionFilterProp="label"
                    placeholder={t("access.rolePlaceholder")}
                  />
                </Form.Item>
                <Form.List name="departments">
                  {(fields, { add, remove }) => (
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-sm text-zinc-300">{t("access.departments")}</span>
                        {access.canReadDepartments ? (
                          <Button size="small" icon={<PlusOutlined />} onClick={() => add({ includeDescendants: false })}>
                            {t("access.addDepartment")}
                          </Button>
                        ) : null}
                      </div>
                      <div className="space-y-3">
                        {fields.map(({ key, name, ...restField }) => (
                          <div key={key} className="grid gap-3 border border-white/10 bg-black/20 p-3 sm:grid-cols-[1fr_auto_auto] sm:items-start">
                            <Form.Item
                              {...restField}
                              className="mb-0"
                              name={[name, "departmentId"]}
                              rules={[{ required: true, message: t("access.departmentRequired") }]}
                            >
                              <Select
                                aria-label={t("access.departmentAria")}
                                disabled={!access.canReadDepartments}
                                options={departmentOptions}
                                optionFilterProp="label"
                                placeholder={t("access.departmentPlaceholder")}
                              />
                            </Form.Item>
                            <Form.Item
                              {...restField}
                              className="mb-0"
                              name={[name, "includeDescendants"]}
                              valuePropName="checked"
                              label={t("access.includeDescendants")}
                            >
                              <Switch disabled={!access.canReadDepartments} />
                            </Form.Item>
                            {access.canReadDepartments ? (
                              <Button
                                aria-label={t("access.removeDepartmentAria")}
                                danger
                                type="text"
                                icon={<DeleteOutlined />}
                                onClick={() => remove(name)}
                              />
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </Form.List>
                {access.canAssignAccess ? (
                  <div className="mt-7 flex justify-end">
                    <Button
                      data-testid="save-agent-access"
                      type="primary"
                      loading={savingSection === "access"}
                      onClick={() => void saveInvocationAccess()}
                    >
                      {t("access.save")}
                    </Button>
                  </div>
                ) : null}
              </Form>
            </div>
          ),
        }] : []),
      ]
    : [];

  return (
    <main className="agentmix-grid min-h-[calc(100dvh-3.5rem)]">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
        <section className="mb-8 flex flex-col justify-between gap-5 md:flex-row md:items-end">
          <div>
            <p className="m-0 font-mono text-xs tracking-[0.26em] text-[#b8f500] uppercase">
              {t("page.eyebrow")}
            </p>
            <h1 className="mb-0 mt-3 text-4xl font-semibold tracking-[-0.045em]">{t("page.title")}</h1>
            <p className="mb-0 mt-3 max-w-2xl text-sm leading-6 text-zinc-500">{t("page.intro")}</p>
          </div>
          {access.canCreate ? (
            <Button data-testid="create-agent" type="primary" size="large" icon={<PlusOutlined />} onClick={openCreate}>
              {t("page.create")}
            </Button>
          ) : null}
        </section>

        <section className="border border-white/10 bg-[#0d1011]/95">
          <div className="flex flex-col gap-3 border-b border-white/10 p-4 md:flex-row">
            <Input
              data-testid="agent-search"
              allowClear
              aria-label={t("filters.searchAria")}
              className="md:max-w-sm"
              prefix={<SearchOutlined />}
              placeholder={t("filters.searchPlaceholder")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              onPressEnter={() => navigate()}
            />
            <Select
              aria-label={t("filters.statusAria")}
              className="w-full md:w-40"
              value={status}
              options={[
                { label: t("filters.allStatuses"), value: "" },
                { label: t("status.active"), value: "active" },
                { label: t("status.disabled"), value: "disabled" },
              ]}
              onChange={setStatus}
            />
            <Button data-testid="apply-agent-filters" icon={<ReloadOutlined />} onClick={() => navigate()}>
              {t("filters.apply")}
            </Button>
          </div>
          <Table<AgentSummary>
            rowKey="id"
            columns={columns}
            dataSource={initialData.items}
            locale={{ emptyText: <Empty description={t("table.empty")} /> }}
            scroll={{ x: 880 }}
            pagination={{
              current: initialData.page,
              pageSize: initialData.pageSize,
              total: initialData.total,
              showSizeChanger: false,
              showTotal: (total) => t("table.total", { total }),
              onChange: (page) => navigate(page),
            }}
          />
        </section>
      </div>

      <Drawer
        destroyOnHidden
        size={760}
        open={drawerOpen}
        title={mode === "create" ? t("drawer.createTitle") : selected?.name ?? t("drawer.loadingTitle")}
        extra={selected ? (
          <Space>
            {selected.isSystem ? <Tag color="geekblue">SYSTEM</Tag> : null}
            <Tag color={selected.status === "active" ? "lime" : "default"}>
              {selected.status === "active" ? "ACTIVE" : "DISABLED"}
            </Tag>
          </Space>
        ) : null}
        onClose={closeDrawer}
      >
        {error ? <Alert className="mb-5" type="error" showIcon title={error} closable onClose={() => setError(null)} /> : null}
        {notice ? <Alert className="mb-5" type="success" showIcon title={notice} closable onClose={() => setNotice(null)} /> : null}
        {loadingDetail ? (
          <div className="py-20 text-center text-zinc-500">{t("drawer.resolving")}</div>
        ) : mode === "create" ? (
          <Form<ProfileFormValues>
            form={profileForm}
            clearOnDestroy
            initialValues={{ slug: "", name: "", description: "", status: "active" }}
            layout="vertical"
            requiredMark={false}
            onFinish={(values) => void submitCreate(values)}
          >
            <SectionHeading
              icon={<RobotOutlined />}
              title={t("create.heading")}
              detail={t("create.headingDetail")}
            />
            <Form.Item
              name="slug"
              label={t("form.slug")}
              rules={[
                { required: true, message: t("form.slugRequired") },
                { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: t("form.slugPattern") },
                { min: 3, max: 100 },
              ]}
            >
              <Input data-testid="agent-slug" placeholder={t("form.slugPlaceholder")} />
            </Form.Item>
            <Form.Item name="name" label={t("form.name")} rules={[{ required: true }, { max: 120 }]}>
              <Input data-testid="agent-name" placeholder={t("form.namePlaceholder")} />
            </Form.Item>
            <Form.Item name="description" label={t("form.description")} rules={[{ max: 2000 }]}>
              <Input.TextArea rows={5} placeholder={t("form.descriptionPlaceholder")} />
            </Form.Item>
            <div className="mt-7 flex justify-end gap-3">
              <Button onClick={closeDrawer}>{t("create.cancel")}</Button>
              <Button data-testid="submit-agent" type="primary" htmlType="submit" loading={savingSection === "create"}>
                {t("create.submit")}
              </Button>
            </div>
          </Form>
        ) : selected ? (
          <Tabs
            activeKey={activeDetailTab}
            items={detailTabs}
            destroyOnHidden={false}
            onChange={setActiveDetailTab}
          />
        ) : null}
      </Drawer>
    </main>
  );
}
