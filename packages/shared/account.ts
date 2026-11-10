export const passwordLimits = {min:8,max:20} as const;
export const guestLifetimeHours = 24;

export function newPasswordError(password:string) {
  const length = [...password].length;
  if (length < passwordLimits.min) return '密码至少需要 8 个字符';
  if (length > passwordLimits.max) return '密码不能超过 20 个字符';
}
