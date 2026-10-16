require_relative 'sdk_conditions'

config = T3NativeControlsSdkConditions
raise '27.0 must omit the flag' unless config.xcconfig('iphoneos' => '27.0', 'iphonesimulator' => '27.0').empty?
%w[27.1 27.2].each do |version|
  actual = config.xcconfig('iphoneos' => version, 'iphonesimulator' => version)
  %w[iphoneos iphonesimulator].each do |sdk|
    expected = '$(inherited) T3_HAS_IOS_27_1_SDK'
    raise "#{sdk} #{version} must enable the flag" unless actual["SWIFT_ACTIVE_COMPILATION_CONDITIONS[sdk=#{sdk}*]"] == expected
  end
end
raise 'unavailable SDK must omit the flag' unless config.xcconfig({}).empty?
raise 'invalid SDK version must omit the flag' unless config.xcconfig('iphoneos' => 'unknown').empty?
partial = config.xcconfig('iphoneos' => '27.1', 'iphonesimulator' => '27.0')
raise 'SDK platforms must remain independent' unless partial.keys == ['SWIFT_ACTIVE_COMPILATION_CONDITIONS[sdk=iphoneos*]']
failed = Struct.new(:success?).new(false)
versions = config.detect_versions(->(*) { ['', 'unavailable', failed] })
raise 'failed SDK lookup must omit the flag' unless config.xcconfig(versions).empty?
versions = config.detect_versions(->(*) { raise Errno::ENOENT })
raise 'missing xcrun must omit the flag' unless config.xcconfig(versions).empty?
puts 'SDK conditions: 27.0 omitted; 27.1/27.2 enabled; unavailable omitted; platforms independent.'
