import { SERVER_URL } from '../../config.js'
Page({
  data: { url: '' },
  onLoad(options) {
    const pair = options.pair || ''
    wx.login({
      success: (res) => {
        if (!res.code) { wx.showToast({ title: '微信登录失败', icon: 'error' }); return }
        const url = SERVER_URL + '/bridge/wxauth?code=' + encodeURIComponent(res.code) + (pair ? '&pair=' + encodeURIComponent(pair) : '')
        this.setData({ url })
      },
      fail: () => wx.showToast({ title: '微信登录失败', icon: 'error' }),
    })
  },
})
