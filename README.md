## 一个webgl&webgpu三维渲染功能集合
一个webgl&webgpu单功能集合, 用于学习使用。

## 文件构成
`ability`文件夹是单一三维渲染功能代码
`appearance`文件夹是单一材质代码
`ui`文件夹是渲染界面, html和css代码
`utils`文件夹, 通用功能代码

## 已经实现功能

1. 基础渲染流程：完成着色器编译、顶点与 uniform 数据上传、MVP 变换和深度测试，绘制一个静态立方体。
2. Phong 光照：给立方体加上法线，用环境光、漫反射和镜面高光逐像素计算光照。
3. 旋转动画：用 `requestAnimationFrame` 按时间增量驱动立方体旋转，每帧重算矩阵并显示 FPS。
