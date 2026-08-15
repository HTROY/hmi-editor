import { useState } from "react";
import { App as AntdApp } from "antd";
import type { FormInstance } from "antd";
import { errMsg } from "../utils/error";

type FieldValues<T> = Parameters<FormInstance<T>["setFieldsValue"]>[0];

interface UseModalFormOptions<TForm, TRecord> {
  form: FormInstance<TForm>;
  /** 提交回调：创建时 editing 为 null。抛错会在此处统一提示并保持弹窗打开。 */
  submit: (values: TForm, editing: TRecord | null) => Promise<void>;
  /** 提交成功后是否自动关闭弹窗。 */
  closeOnSuccess?: boolean;
  /** 保存失败提示前缀。 */
  errorPrefix?: string;
}

/**
 * 弹窗表单状态机：openCreate / openEdit / save / close 与
 * open、editing、saving 状态，Plugins / Points / AlarmRules 共用。
 */
export function useModalForm<TForm, TRecord>({
  form,
  submit,
  closeOnSuccess = true,
  errorPrefix = "保存失败",
}: UseModalFormOptions<TForm, TRecord>) {
  const { message } = AntdApp.useApp();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<TRecord | null>(null);
  const [saving, setSaving] = useState(false);

  const openCreate = (defaults?: Partial<TForm>) => {
    setEditing(null);
    form.resetFields();
    if (defaults) form.setFieldsValue(defaults as FieldValues<TForm>);
    setOpen(true);
  };

  const openEdit = (record: TRecord, values: TForm) => {
    setEditing(record);
    form.setFieldsValue(values as FieldValues<TForm>);
    setOpen(true);
  };

  const close = () => setOpen(false);

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await submit(values, editing);
      if (closeOnSuccess) setOpen(false);
    } catch (e) {
      message.error(`${errorPrefix}: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return { open, editing, saving, openCreate, openEdit, save, close };
}
