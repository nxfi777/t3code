require 'open3'
require 'rubygems/version'

module T3NativeControlsSdkConditions
  FLAG = 'T3_HAS_IOS_27_1_SDK'.freeze
  MINIMUM = Gem::Version.new('27.1')
  SDKS = %w[iphoneos iphonesimulator].freeze

  # CocoaPods generates the target configuration for the selected Xcode.
  # Run pod install again after changing Xcode or its SDKs. Swift compiler 6.4
  # alone is insufficient: it also ships with the iOS 27.0 SDK.
  def self.xcconfig(versions)
    SDKS.each_with_object({}) do |sdk, config|
      version = versions[sdk].to_s.strip
      next unless version.match?(/\A\d+(?:\.\d+)*\z/)
      next unless Gem::Version.new(version) >= MINIMUM

      config["SWIFT_ACTIVE_COMPILATION_CONDITIONS[sdk=#{sdk}*]"] = "$(inherited) #{FLAG}"
    end
  end

  def self.detect_versions(run_command = ->(*args) { Open3.capture3(*args) })
    SDKS.to_h do |sdk|
      begin
        stdout, _stderr, status = run_command.call('xcrun', '--sdk', sdk, '--show-sdk-version')
        [sdk, status.success? ? stdout.strip : nil]
      rescue SystemCallError
        [sdk, nil]
      end
    end
  end
end
