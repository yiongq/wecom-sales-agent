// 图标（spec「视觉与字体 · 图标」，设计系统 §7）：lucide-react，任何尺寸下线宽都是 1.5px（absoluteStrokeWidth），颜色随文字。
// 实体图标由行业包给 lucide 名称，只能取 §7 的实体图标集合；console 只为这个集合打包图标组件，加一个行业包不用改 console。
// 第 3.1 步的 checkPack 校验包里的图标名在集合里；集合以外的名字这里画成 box，不报错
import {
  BedDouble,
  Box,
  Boxes,
  Briefcase,
  Building2,
  Car,
  FileText,
  Gift,
  GraduationCap,
  History,
  House,
  Layers,
  type LucideIcon,
  MessageSquareText,
  MessagesSquare,
  Package,
  Plane,
  Route,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  Stethoscope,
  Store,
  Tag,
  Tags,
  Ticket,
  Utensils,
  Wrench,
} from 'lucide-react';
import type { NavIcon } from './model.js';

/** 设计系统 §7 的实体图标集合 */
const ENTITY_ICONS: Readonly<Record<string, LucideIcon>> = {
  route: Route,
  'bed-double': BedDouble,
  package: Package,
  layers: Layers,
  box: Box,
  boxes: Boxes,
  tag: Tag,
  tags: Tags,
  'shopping-bag': ShoppingBag,
  'shopping-cart': ShoppingCart,
  store: Store,
  gift: Gift,
  ticket: Ticket,
  'file-text': FileText,
  briefcase: Briefcase,
  'building-2': Building2,
  house: House,
  car: Car,
  plane: Plane,
  utensils: Utensils,
  shirt: Shirt,
  wrench: Wrench,
  'graduation-cap': GraduationCap,
  stethoscope: Stethoscope,
};

/** 固定页面的图标：销售话术 / 会话 / 审计日志 */
const PAGE_ICONS: Readonly<Record<'sop' | 'conversations' | 'audit', LucideIcon>> = {
  sop: MessageSquareText,
  conversations: MessagesSquare,
  audit: History,
};

export const entityIcon = (name: string): LucideIcon => (Object.hasOwn(ENTITY_ICONS, name) ? ENTITY_ICONS[name]! : Box);

export const navIcon = (icon: NavIcon): LucideIcon => ('page' in icon ? PAGE_ICONS[icon.page] : entityIcon(icon.entity));

/** 一个图标：装饰性的，读屏跳过（按钮自己带 aria-label） */
export function Icon({ of: C, size = 16, className }: { of: LucideIcon; size?: number; className?: string }) {
  return <C size={size} strokeWidth={1.5} absoluteStrokeWidth aria-hidden="true" focusable="false" className={className} />;
}
