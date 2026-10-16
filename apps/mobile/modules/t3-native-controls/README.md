# Native layout metrics SDK compatibility

`T3LayoutMetricsView` compiles the hinge and reserved-region APIs only when all three conditions hold: Swift compiler 6.4 or later, an iOS SDK version of 27.1 or later detected during CocoaPods generation, and iOS 27.1 or later at runtime. Xcode 27.0 has Swift 6.4 but lacks these UIKit declarations.

The podspec detects the selected `iphoneos` and `iphonesimulator` SDK versions separately with `xcrun`. It adds `T3_HAS_IOS_27_1_SDK` only to this pod's corresponding SDK build settings. An unavailable or invalid SDK version leaves the flag absent. Older SDKs retain ordinary-phone size-class, bounds, and safe-area metrics, with no hinge or reserved regions.

After changing the selected Xcode or SDK, run `pod install` again from `apps/mobile/ios` before building. Detection happens when CocoaPods generates the target configuration.

Run the focused configuration checks with:

```sh
ruby apps/mobile/modules/t3-native-controls/ios/sdk_conditions.test.rb
```
