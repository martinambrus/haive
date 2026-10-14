// Web-safe (no imports). TAB and LF stay allowed; the rest is every character a model reads and a person does not see.
export const HIDDEN_CHARACTER =
  /[\u{0}-\u{8}\u{B}-\u{1F}\u{7F}-\u{9F}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Zl}\p{Zp}]/u;
