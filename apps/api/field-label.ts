export type FieldEvidence = {
  id: string;
  name: string;
  type: string;
  autocomplete: string;
  placeholder: string;
  cue: string;
  nearby: string;
  formTitle: string;
  groupTitle: string;
  relatedName: string;
  description: string;
};

const fieldTypes: Readonly<Record<string, string>> = {
  email: '电子邮箱', tel: '电话号码', url: '网址', search: '搜索关键词',
};
const autocompleteLabels: Readonly<Record<string, string>> = {
  email: '电子邮箱', tel: '电话号码', url: '网址', username: '用户名', name: '姓名',
  'given-name': '名字', 'family-name': '姓氏', 'postal-code': '邮政编码', 'street-address': '街道地址',
  organization: '机构名称', 'current-password': '当前密码', 'new-password': '新密码',
};
const concepts: [string, RegExp][] = [
  ['电子邮箱', /^(?:e ?mail(?: address)?|电子邮件|电子邮箱|邮箱(?:地址)?)$/iu],
  ['电话号码', /^(?:phone(?: number)?|tel|telephone(?: number)?|mobile(?: number)?|手机号(?:码)?|联系?电话|电话号码|电话)$/iu],
  ['名字', /^(?:given name|first name|名字)$/iu],
  ['姓氏', /^(?:family name|last name|surname|姓氏)$/iu],
  ['姓名', /^(?:name|full name|姓名|全名)$/iu],
  ['邮政编码', /^(?:postal code|zip(?: code)?|邮编|邮政编码)$/iu],
  ['街道地址', /^(?:street address|街道地址)$/iu],
  ['机构名称', /^(?:organization(?: name)?|company(?: name)?|机构名称|公司名称)$/iu],
  ['用户名', /^(?:user ?name|用户名)$/iu],
  ['网址', /^(?:url|website(?: url)?|网址)$/iu],
];
const roles: [RegExp, string, RegExp][] = [
  [/^(?:student|learner|学员|学生)\s*/iu, '学生', /课程|学习|教育|学籍|学校|选课|\b(?:course|education|school|student|training|class)\b/iu],
  [/^(?:applicant|申请人)\s*/iu, '申请人', /申请|申报|\bapplication\b/iu],
  [/^(?:guardian|监护人)\s*/iu, '监护人', /监护|家长|\b(?:guardian|parent|minor)\b/iu],
  [/^(?:customer|客户)\s*/iu, '客户', /订单|客户|购买|\b(?:order|customer|checkout)\b/iu],
];
const bland = /^(?:输入|请输入|选填|必填|填写|请填写|请选择|提交|备注说明|input|enter|optional|required|select|submit)$/iu;

function words(value: string) {
  return value.replace(/([a-z\d])([A-Z])/g, '$1 $2').replace(/[_.\[\]-]+/g, ' ').trim();
}
function phrase(value: string) {
  return value.replace(/\s+/g, ' ').replace(/[:：*＊]+$/, '').trim();
}
function meaning(value: string, context: string) {
  const normalized = words(phrase(value));
  for (const [pattern, title, domain] of roles) {
    const match = normalized.match(pattern);
    if (match && /^(?:full name|name|姓名)$/iu.test(normalized.slice(match[0].length).trim()) && domain.test(context)) {
      return { concept: '姓名', value: title + '姓名' };
    }
  }
  const term = concepts.find(([, pattern]) => pattern.test(normalized))?.[0];
  return term ? { concept: term, value: term } : undefined;
}

export function fieldRecommendation(field: FieldEvidence) {
  const context = [field.formTitle, field.groupTitle, field.nearby, field.description].join(' ');
  const type = Object.hasOwn(fieldTypes, field.type) ? fieldTypes[field.type] : undefined;
  const autocomplete = Object.hasOwn(autocompleteLabels, field.autocomplete) ? autocompleteLabels[field.autocomplete] : undefined;
  const direct = phrase(field.relatedName || field.cue);
  const visibleName = direct.length >= 2 && direct.length <= 60 && !bland.test(direct) &&
    /^[\p{L}][\p{L}\p{N} /\-·]+$/u.test(direct) ? direct : undefined;
  const placeholder = meaning(field.placeholder.replace(/^(?:请输入|请填写|enter\s+(?:your\s+)?)/iu, ''), context);
  const identifiers = [meaning(field.id, context), meaning(field.name, context)];
  const visibleMeaning = visibleName && meaning(visibleName, context);
  const strong = new Set([type, autocomplete, visibleMeaning ? visibleMeaning.concept : undefined, placeholder?.concept].filter(Boolean));
  if (strong.size > 1) return { reason: '输入类型、自动填充或页面文案指向不同用途。请确认这个字段实际收集什么信息。' };
  if (visibleName) return { value: visibleName, reason: '名称来自关联元素或紧邻的可见字段文案，请核对是否符合表单用途。' };
  if (autocomplete || type) return { value: (autocomplete ?? type)!, reason: '输入类型或自动填充语义明确，请核对推荐名称。' };
  if (placeholder) return { value: placeholder.value, reason: '占位提示明确描述了要填写的信息，请核对推荐名称。' };

  const [id, name] = identifiers;
  if (id && name && id.concept !== name.concept) return { reason: '字段的 id 和 name 指向不同用途。请确认实际收集的信息。' };
  const contextualRole = identifiers.find(item => item && item.value !== item.concept);
  if (contextualRole) return { value: contextualRole.value, reason: '字段命名与表单标题或附近说明互相印证，请确认这个名称。' };
  if (id && name) return { value: name.value, reason: '字段的 id 和 name 对用途的描述一致，请确认这个名称。' };
  return { reason: field.id || field.name
    ? '只有字段标识或通用说明，缺少能核对用途的字段文案。请填写用户应在此输入什么。'
    : '缺少能说明字段用途的标签、提示或语义属性。请填写用户应在此输入什么。' };
}
