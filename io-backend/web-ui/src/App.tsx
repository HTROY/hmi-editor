import { useState } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import {
  AppstoreOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  DesktopOutlined,
  MoonOutlined,
  RadarChartOutlined,
  SunOutlined,
} from "@ant-design/icons";
import {
  Breadcrumb,
  Button,
  Layout,
  Menu,
  Space,
  Tag,
  theme as antdTheme,
} from "antd";
import type { MenuProps } from "antd";
import Dashboard from "./pages/Dashboard";
import Plugins from "./pages/Plugins";
import Points from "./pages/Points";
import Monitor from "./pages/Monitor";
import { useTheme } from "./theme";

const { Sider, Header, Content } = Layout;

const MENU_ITEMS: NonNullable<MenuProps["items"]> = [
  { key: "/", icon: <DashboardOutlined />, label: "运行总览" },
  { key: "/plugins", icon: <AppstoreOutlined />, label: "协议插件" },
  { key: "/points", icon: <DatabaseOutlined />, label: "点位配置" },
  { key: "/monitor", icon: <RadarChartOutlined />, label: "实时监控" },
];

const TITLES: Record<string, string> = {
  "/": "运行总览",
  "/plugins": "协议插件",
  "/points": "点位配置",
  "/monitor": "实时监控",
};

export default function App() {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { isDark, toggle } = useTheme();
  const { token } = antdTheme.useToken();

  const selected = MENU_ITEMS.some((i) => i?.key === location.pathname)
    ? location.pathname
    : "/";

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={setCollapsed}
        theme={isDark ? "dark" : "light"}
        width={220}
      >
        <div
          style={{
            height: 56,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            fontWeight: 700,
            fontSize: 15,
            color: token.colorText,
            overflow: "hidden",
          }}
        >
          <DesktopOutlined style={{ color: "#3b82f6", fontSize: 20 }} />
          {!collapsed && <span>HMI IO 控制台</span>}
        </div>
        <Menu
          theme={isDark ? "dark" : "light"}
          mode="inline"
          selectedKeys={[selected]}
          items={MENU_ITEMS}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 20px",
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Breadcrumb
            items={[
              { title: "HMI IO" },
              { title: TITLES[selected] ?? "控制台" },
            ]}
          />
          <Space size="middle">
            <Tag color="blue" icon={<RadarChartOutlined />}>
              实时刷新
            </Tag>
            <Button
              type="text"
              icon={isDark ? <SunOutlined /> : <MoonOutlined />}
              onClick={toggle}
              aria-label="切换主题"
            />
          </Space>
        </Header>
        <Content style={{ padding: 20, overflow: "auto" }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/plugins" element={<Plugins />} />
            <Route path="/points" element={<Points />} />
            <Route path="/monitor" element={<Monitor />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}
