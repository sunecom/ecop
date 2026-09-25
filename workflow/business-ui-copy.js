(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ECOPBusinessUiCopy = factory();
})(globalThis, function () {
  "use strict";

  function accountBoundary(multiUser) {
    return multiUser
      ? "项目按独立站点认证账号与项目成员授权保存；源资料读取仍使用单独 ACL。"
      : "项目按当前站点认证账号保存；当前仅配置一个独立登录账号，真实双人审核尚不可用。";
  }

  function sourceAccessBoundary(multiUser) {
    return multiUser
      ? "项目按独立站点身份逐请求校验；源快照仅对显式源 ACL 账号可见。"
      : "项目由站点认证账号绑定；当前仅配置一个独立登录账号。";
  }

  function roleModeBoundary(multiUser) {
    return multiUser
      ? "项目权限按站点独立登录身份逐请求校验；页面不能切换成他人角色。"
      : "项目写入身份来自站点认证，不读取页面角色选择；当前仅配置一个独立登录账号，真实多人审核尚不可用。";
  }

  return Object.freeze({ accountBoundary, sourceAccessBoundary, roleModeBoundary });
});
