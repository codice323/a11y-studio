globalThis.a11yStudioCaptureScreenshot = async target => {
  const limit = 5_300_000;
  const visible = async () => {
    const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {format:'png', fromSurface:true});
    if (!result?.data || result.data.length > limit) throw new Error('截图超过 4 MB，请缩小浏览器窗口后重试。');
    return {data:result.data, fullPage:false};
  };

  try {
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics');
    const size = metrics?.cssContentSize || metrics?.contentSize;
    if (size?.width > 0 && size?.height > 0 && size.width <= 12000 && size.height <= 12000 && size.width * size.height <= 60_000_000) {
      const result = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
        format:'png', fromSurface:true, captureBeyondViewport:true,
        clip:{x:0, y:0, width:size.width, height:size.height, scale:1},
      });
      if (result?.data && result.data.length <= limit) return {data:result.data, fullPage:true};
    }
  } catch {}
  return visible();
};
